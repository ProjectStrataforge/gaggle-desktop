/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AuthenticationError, NetworkError, NotFoundError, type Chunk, type CompletionStream, type RoutingInfo, type Usage } from '@projectstrataforge/sovereign-router-sdk';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/protocol/common/actions.js';
import { ResponsePartKind } from '../../common/state/protocol/channels-chat/state.js';
import { mapTurnError, runTurn } from '../../node/gaggle/gaggleTurnRunner.js';

// Gaggle 114 — the turn runner maps the SMR SDK stream onto the host's chat
// actions. These tests script the stream and read the signals back.

const PROMPT = 'reply with the single word pong';

function fakeStream(chunks: readonly string[], opts: { usage?: Usage; routing?: RoutingInfo; failWith?: unknown; abortAfter?: { index: number; controller: AbortController } } = {}): CompletionStream {
	const usage: Usage = opts.usage ?? { promptTokens: 7, completionTokens: 1, totalTokens: 8 };
	const iterable = {
		usage,
		routing: opts.routing,
		async *[Symbol.asyncIterator](): AsyncGenerator<Chunk> {
			for (let i = 0; i < chunks.length; i++) {
				if (opts.failWith && i === 1) {
					throw opts.failWith;
				}
				yield { delta: chunks[i] };
				if (opts.abortAfter && i === opts.abortAfter.index) {
					opts.abortAfter.controller.abort();
				}
			}
			if (opts.failWith && chunks.length < 2) {
				throw opts.failWith;
			}
		},
	};
	return iterable as unknown as CompletionStream;
}

function sdkError<T extends object>(proto: { prototype: T }, message: string): T {
	const err = Object.create(proto.prototype) as T & { message: string };
	err.message = message;
	return err;
}

class RecordingLog extends NullLogService {
	readonly lines: string[] = [];
	override info(message: string): void { this.lines.push(message); }
	override warn(message: string): void { this.lines.push(message); }
	override error(message: string | Error): void { this.lines.push(String(message)); }
}

suite('gaggleTurnRunner (114)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const chat = AgentSession.uri('gaggle', 'session-1');
	const baseInput = (client: { stream: CompletionStream | (() => CompletionStream) }, signal: AbortSignal) => ({
		chat,
		turnId: 'turn-1',
		hop: 'local' as const,
		model: 'nemotron-3-nano:4b',
		messages: [{ role: 'user' as const, content: PROMPT }],
		client: { stream: () => (typeof client.stream === 'function' ? client.stream() : client.stream) },
		signal,
	});

	function actionsOf(signals: AgentSignal[]): { type: ActionType; [k: string]: unknown }[] {
		return signals.map(s => (s.kind === 'action' ? (s.action as unknown as { type: ActionType }) : { type: 'not-an-action' as unknown as ActionType }));
	}

	test('a streamed reply becomes part → deltas → attribution → usage → complete, in that order', async () => {
		const signals: AgentSignal[] = [];
		const log = new RecordingLog();
		const stream = fakeStream(['po', 'ng'], { routing: { servedModel: 'nemotron-3-nano:4b', fallbackChain: [], latencyMs: 42 } });
		const outcome = await runTurn(baseInput({ stream }, new AbortController().signal), s => signals.push(s), log);

		const types = actionsOf(signals).map(a => a.type);
		assert.deepStrictEqual(types, [
			ActionType.ChatResponsePart,          // empty markdown reply part (must exist before deltas)
			ActionType.ChatActivityChanged,       // streaming
			ActionType.ChatDelta,
			ActionType.ChatDelta,
			ActionType.ChatResponsePart,          // attribution
			ActionType.ChatUsage,
			ActionType.ChatActivityChanged,       // cleared
			ActionType.ChatTurnComplete,
		]);
		const first = actionsOf(signals)[0] as unknown as { part: { kind: ResponsePartKind; id: string; content: string } };
		assert.strictEqual(first.part.kind, ResponsePartKind.Markdown);
		assert.strictEqual(first.part.content, '');
		const deltas = actionsOf(signals).filter(a => a.type === ActionType.ChatDelta) as unknown as { partId: string; content: string }[];
		assert.deepStrictEqual(deltas.map(d => d.content), ['po', 'ng']);
		assert.ok(deltas.every(d => d.partId === first.part.id), 'deltas append to the reply part');
		assert.strictEqual(outcome.state, 'complete');
		assert.strictEqual(outcome.replyMarkdown, 'pong');
		assert.strictEqual(outcome.attribution?.servedModel, 'nemotron-3-nano:4b');
		assert.strictEqual(outcome.usage?.completionTokens, 1);
		for (const s of signals) {
			assert.strictEqual(s.kind === 'action' ? s.resource.toString() : '', chat.toString());
		}
	});

	test('the log line carries hop, model, tokens — never the prompt or the reply', async () => {
		const signals: AgentSignal[] = [];
		const log = new RecordingLog();
		await runTurn(baseInput({ stream: fakeStream(['pong']) }, new AbortController().signal), s => signals.push(s), log);
		const line = log.lines.find(l => l.startsWith('gaggle turn turn-1:'));
		assert.ok(line, 'one attribution log line');
		assert.match(line!, /hop=local model=nemotron-3-nano:4b/);
		assert.match(line!, /prompt_tokens=7 completion_tokens=1/);
		assert.doesNotMatch(line!, /pong|single word/);
	});

	test('abort mid-stream stops within one chunk and emits no completion', async () => {
		const signals: AgentSignal[] = [];
		const controller = new AbortController();
		const stream = fakeStream(['a', 'b', 'c', 'd'], { abortAfter: { index: 0, controller } });
		const outcome = await runTurn(baseInput({ stream }, controller.signal), s => signals.push(s), new RecordingLog());
		assert.strictEqual(outcome.state, 'cancelled');
		const types = actionsOf(signals).map(a => a.type);
		assert.strictEqual(types.filter(t => t === ActionType.ChatDelta).length, 1, 'exactly the chunk in flight');
		assert.ok(!types.includes(ActionType.ChatTurnComplete), 'the host owns the cancelled state');
		assert.ok(!types.includes(ActionType.ChatError));
	});

	test('a failing stream becomes ChatError with actionable copy and no sign-in demand', async () => {
		const signals: AgentSignal[] = [];
		const stream = fakeStream(['x', 'y'], { failWith: sdkError(NetworkError, 'ECONNREFUSED 127.0.0.1:8000') });
		const outcome = await runTurn(baseInput({ stream }, new AbortController().signal), s => signals.push(s), new RecordingLog());
		assert.strictEqual(outcome.state, 'error');
		const errorAction = actionsOf(signals).find(a => a.type === ActionType.ChatError) as unknown as { error: { errorType: string; message: string } };
		assert.ok(errorAction, 'ChatError emitted');
		assert.strictEqual(errorAction.error.errorType, 'hopUnreachable');
		assert.match(errorAction.error.message, /SMR hop \(local\)/);
		assert.doesNotMatch(errorAction.error.message, /sign in|GitHub|Copilot/i);
	});

	test('error mapping table', () => {
		assert.strictEqual(mapTurnError(sdkError(AuthenticationError, 'x'), 'remote', 'm').errorType, 'noCredential');
		assert.strictEqual(mapTurnError(sdkError(NotFoundError, 'x'), 'local', 'm').errorType, 'modelUnknown');
		assert.strictEqual(mapTurnError(sdkError(NetworkError, 'x'), 'local', 'm').errorType, 'hopUnreachable');
		assert.strictEqual(mapTurnError(new Error('boom\nstack'), 'local', 'm').message.includes('stack'), false);
	});

	test('a chat URI other than the session URI is passed through as the signal resource', async () => {
		const peer = URI.parse('ahp-chat://chat-9/' + Buffer.from(chat.toString()).toString('base64'));
		const signals: AgentSignal[] = [];
		await runTurn({ ...baseInput({ stream: fakeStream(['ok']) }, new AbortController().signal), chat: peer }, s => signals.push(s), new RecordingLog());
		assert.ok(signals.every(s => s.kind === 'action' && s.resource.toString() === peer.toString()));
	});
});
