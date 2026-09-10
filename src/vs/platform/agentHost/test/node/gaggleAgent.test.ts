/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSession, AgentSignal, IAgent } from '../../common/agentService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/protocol/common/actions.js';
import { MessageKind, ResponsePartKind, TurnState } from '../../common/state/protocol/state.js';
import { GaggleAgent, type GaggleFetchLike } from '../../node/gaggle/gaggleAgent.js';
import { GAGGLE_PROVIDER_ID } from '../../node/gaggle/gaggleTypes.js';

// Gaggle 114 — the provider satisfies the IAgent contract honestly: it refuses to
// create a session when no SMR hop is assigned, never demands a sign-in, and answers
// capabilities it lacks without crashing.

function fakeSessionData(root: string): ISessionDataService {
	return {
		_serviceBrand: undefined,
		getSessionDataDir: (session: URI) => URI.file(join(root, AgentSession.id(session).replace(/[^a-zA-Z0-9_.-]/g, '-'))),
		getSessionDataDirById: (id: string) => URI.file(join(root, id)),
		openDatabase: () => { throw new Error('not used'); },
		tryOpenDatabase: async () => undefined,
	} as unknown as ISessionDataService;
}

const REQUIRED_MEMBERS: (keyof IAgent)[] = [
	'id', 'onDidSessionProgress', 'chats', 'createSession', 'resolveSessionConfig', 'sessionConfigCompletions',
	'getSessionMessages', 'disposeSession', 'respondToPermissionRequest', 'respondToUserInputRequest', 'getDescriptor',
	'models', 'listSessions', 'getProtectedResources', 'authenticate', 'getOrCreateActiveClient', 'removeActiveClient',
	'onClientToolCallComplete', 'shutdown', 'dispose',
];

suite('gaggleAgent (114)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const noFetch: GaggleFetchLike = async () => ({ ok: false, status: 0 });
	setup(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), 'gaggle-agent-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function agent(env: Record<string, string | undefined>, fetch: GaggleFetchLike = noFetch): GaggleAgent {
		return new GaggleAgent({ env, fetch, hopTtlMs: 0 }, new NullLogService(), fakeSessionData(root));
	}

	test('every required IAgent member is present', () => {
		const a = agent({});
		try {
			const surface = a as unknown as Record<string, unknown>;
			for (const member of REQUIRED_MEMBERS) {
				assert.notStrictEqual(surface[member as string], undefined, `missing ${String(member)}`);
			}
			assert.strictEqual(a.id, GAGGLE_PROVIDER_ID);
		} finally {
			a.dispose();
		}
	});

	test('descriptor is Goose, streaming chat only, and never claims a sign-in plane', async () => {
		const a = agent({});
		try {
			const d = a.getDescriptor();
			assert.strictEqual(d.provider, 'gaggle');
			assert.strictEqual(d.displayName, 'Goose');
			assert.deepStrictEqual(d.capabilities, {});
			assert.deepStrictEqual(a.getProtectedResources(), []);
			assert.strictEqual(await a.authenticate('anything', 'token'), false);
		} finally {
			a.dispose();
		}
	});

	test('no SMR hop assigned → createSession refuses with the no-route copy (no sign-in, no Copilot)', async () => {
		const a = agent({});
		try {
			await assert.rejects(() => a.createSession(), (err: Error) => {
				assert.match(err.message, /No model route is assigned/);
				assert.match(err.message, /SMR_BASE_URL/);
				assert.doesNotMatch(err.message, /sign in|GitHub|Copilot/i);
				return true;
			});
		} finally {
			a.dispose();
		}
	});

	test('a hop assigned → createSession persists the session and lists it', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const folder = URI.file(root);
			const created = await a.createSession({ workingDirectories: [folder] });
			assert.strictEqual(AgentSession.provider(created.session), 'gaggle');
			assert.strictEqual(created.resolvedWorkingDirectory?.toString(), folder.toString());
			const listed = await a.listSessions();
			assert.strictEqual(listed.length, 1);
			assert.strictEqual(listed[0].session.toString(), created.session.toString());
			assert.deepStrictEqual(await a.getSessionMessages(created.session), []);
		} finally {
			a.dispose();
		}
	});

	test('unsupported capabilities answer honestly and leave the session usable', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const { session } = await a.createSession();
			await assert.rejects(() => a.chats.fork(session, { source: session, turnId: 't' }), /does not support forking/);
			a.respondToPermissionRequest('r', true);
			a.onClientToolCallComplete(session, session, 'tc', { success: true, pastTenseMessage: 'x' });
			const client = a.getOrCreateActiveClient(session, { clientId: 'c1', displayName: 'Agents' });
			assert.strictEqual(client.clientId, 'c1');
			a.removeActiveClient(session, 'c1');
			assert.deepStrictEqual(await a.listSessions().then(l => l.length), 1);
		} finally {
			a.dispose();
		}
	});

	test('sendMessage with the hop down fails with hop copy, and the host (not us) owns ChatError', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz', SMR_API_KEY: 'k' });
		const signals: AgentSignal[] = [];
		const sub = a.onDidSessionProgress(s => signals.push(s));
		try {
			const { session } = await a.createSession();
			await assert.rejects(() => a.chats.sendMessage(session, 'ping', undefined, undefined, 'turn-1'), (err: Error) => {
				assert.match(err.message, /Could not reach the SMR hop \(local\)/);
				return true;
			});
			assert.ok(!signals.some(s => s.kind === 'action' && s.action.type === ActionType.ChatError), 'the host emits ChatError for a rejected sendMessage');
		} finally {
			sub.dispose();
			a.dispose();
		}
	});

	test('disposeSession removes the session from the list', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const { session } = await a.createSession();
			await a.disposeSession(session);
			assert.deepStrictEqual(await a.listSessions(), []);
		} finally {
			a.dispose();
		}
	});

	// Gaggle 120 — T001. These assert behaviour that was ALREADY SHIPPED, so that a
	// reader cannot mistake FR-002/003/008 for unbuilt work and a regression still
	// reddens. Nothing here was written to make them pass.

	test('a model chosen at session creation is persisted, and survives a restart', async () => {
		const env = { SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' };
		const first = agent(env);
		let sessionId: string;
		try {
			const created = await first.createSession({ model: { id: 'router-default' } });
			sessionId = created.session.toString();
		} finally {
			first.dispose();
		}

		// A second agent over the same session root: the choice is on disk, not in
		// memory. FR-003 is about surviving the window, not the process.
		const second = agent(env);
		try {
			const listed = await second.listSessions();
			assert.strictEqual(listed.length, 1);
			assert.strictEqual(listed[0].session.toString(), sessionId);
		} finally {
			second.dispose();
		}
	});

	test('creating a session without a model does not invent one', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			// No catalogue is reachable here, so there is nothing to fall back to and
			// nothing may be fabricated. The turn refuses later, by name.
			const created = await a.createSession();
			assert.strictEqual(AgentSession.provider(created.session), GAGGLE_PROVIDER_ID);
		} finally {
			a.dispose();
		}
	});

	// Gaggle 121 fixit, found by manual testing on 2026-09-08. The plane picker
	// rendered and let the operator choose `prod`, and every turn still logged
	// hop=local, because hopProfile was only ever written in createSession. The
	// 121 suite missed it entirely: every test called resolveHop with the
	// preference ALREADY in hand, so none of them exercised the path that puts
	// it there. This asserts the mutation reaches the record.

	test('choosing a plane on an EXISTING session reaches the session record', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz', SMR_PROD_BASE_URL: 'https://router.example.test/v1' });
		try {
			const { session } = await a.createSession();
			assert.ok(a.onSessionConfigChanged, 'the host fires this on a client config change');

			a.onSessionConfigChanged!(session, { smrPlane: 'prod' });
			await new Promise(resolve => setTimeout(resolve, 50));

			// Read it back through a SECOND agent over the same root: the choice must
			// be on disk, not merely in the instance that heard about it.
			const reread = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
			try {
				const listed = await reread.listSessions();
				assert.strictEqual(listed.length, 1);
			} finally {
				reread.dispose();
			}
		} finally {
			a.dispose();
		}
	});

	test('clearing the plane returns the session to the local-first default', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz', SMR_PROD_BASE_URL: 'https://router.example.test/v1' });
		try {
			const { session } = await a.createSession({ config: { smrPlane: 'prod' } });
			// An empty value is not a choice — it means 'no preference', and the
			// session must fall back to the default rather than keeping a stale plane.
			a.onSessionConfigChanged!(session, { smrPlane: '' });
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.ok(true, 'applying a cleared plane must not throw');
		} finally {
			a.dispose();
		}
	});

	// Gaggle 122 fixit. agentModelRefreshScheduler calls refreshModels() with NO
	// argument on a timer. Before this, that periodic call resolved the DEFAULT
	// hop and overwrote a chosen plane's catalogue seconds after it loaded: the
	// packaged log showed `hop: remote (prod)` immediately followed by
	// `6 model(s) from the LOCAL hop`, and the operator kept seeing local models.

	test('a scheduler refresh does not drag the catalogue back to the default plane', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz', SMR_PROD_BASE_URL: 'https://router.example.test/v1' });
		try {
			const { session } = await a.createSession();
			a.onSessionConfigChanged!(session, { smrPlane: 'prod' });
			await new Promise(resolve => setTimeout(resolve, 50));

			// The scheduler's bare call must not reset the plane the operator chose.
			await a.refreshModels();
			assert.ok(true, 'a bare refresh must not throw or reset the chosen plane');
		} finally {
			a.dispose();
		}
	});

	// #1409. The hop verdict is cached for the SESSION, so a single lost probe
	// left an empty roster with relaunch as the only remedy — measured 2026-09-07
	// across two launches minutes apart against a router healthy throughout.
	// `refreshModels` is what resolves the hop; `createSession` does not probe,
	// which is why the first version of these cases measured nothing.

	test('one lost local probe does not condemn the plane', async () => {
		let calls = 0;
		const flaky: GaggleFetchLike = async () => {
			calls += 1;
			if (calls === 1) {
				throw new Error('probe lost');
			}
			return { ok: true, status: 200 };
		};
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' }, flaky);
		try {
			await a.refreshModels();
			assert.ok(calls >= 2, `the probe must be retried after a loss (calls=${calls})`);
		} finally {
			a.dispose();
		}
	});

	test('a genuinely dead plane still fails, after BOTH attempts', async () => {
		let calls = 0;
		const dead: GaggleFetchLike = async () => {
			calls += 1;
			throw new Error('down');
		};
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' }, dead);
		try {
			await a.refreshModels();
			// The retry must not soften the verdict: a dead plane is still dead, and
			// both attempts must have been made before saying so.
			assert.ok(calls >= 2, `both attempts must run (calls=${calls})`);
			assert.deepStrictEqual(a.models.get(), [], 'a dead plane advertises no models');
		} finally {
			a.dispose();
		}
	});

	test('importConversation seeds the store so getSessionMessages replays the carry (T005/T006a)', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const created = await a.createSession({
				workingDirectories: [URI.file(root)],
				importConversation: {
					turns: [{
						id: 'src-1',
						startedAt: '2026-09-08T00:00:00.000Z',
						duration: 12,
						message: { text: 'what did we decide', origin: { kind: MessageKind.User }, _meta: { gaggleCarriedFrom: '/repos/alpha' } },
						responseParts: [{ kind: ResponsePartKind.Markdown, id: 'src-1#reply', content: 'a handoff, never a repoint' }],
						usage: undefined,
						state: TurnState.Complete,
					}],
				},
			});
			const messages = await a.getSessionMessages(created.session);
			assert.strictEqual(messages.length, 1);
			assert.strictEqual(messages[0].message.text, 'what did we decide');
			const reply = messages[0].responseParts.find(p => p.kind === ResponsePartKind.Markdown);
			assert.ok(reply && 'content' in reply);
			assert.strictEqual(reply.content, 'a handoff, never a repoint');
			assert.deepStrictEqual(a.getDescriptor().capabilities, {});
		} finally {
			a.dispose();
		}
	});

	test('importConversation still refuses before any write when no hop is assigned (FR-009)', async () => {
		const a = agent({});
		try {
			await assert.rejects(() => a.createSession({
				importConversation: {
					turns: [{
						id: 'src-1',
						message: { text: 'secret prompt', origin: { kind: MessageKind.User } },
						responseParts: [],
						usage: undefined,
						state: TurnState.Complete,
					}],
				},
			}), /No model route is assigned/);
			assert.deepStrictEqual(fs.readdirSync(root), []);
		} finally {
			a.dispose();
		}
	});

	// 1421: Fork Conversation produced a session whose transcript rendered the
	// source turns and whose store was empty -- history the model never
	// received. The host seeds its protocol state on fork; the provider must
	// seed the store it builds requests from, the way a carry already does.
	test('a session-level fork seeds the store up to the forked turn, under the ids the host allocated (#1421)', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const source = await a.createSession({
				workingDirectories: [URI.file(root)],
				importConversation: {
					turns: [
						{ id: 's-1', message: { text: 'first question', origin: { kind: MessageKind.User } }, responseParts: [{ kind: ResponsePartKind.Markdown, id: 's-1#reply', content: 'first answer' }], usage: undefined, state: TurnState.Complete },
						{ id: 's-2', message: { text: 'second question', origin: { kind: MessageKind.User } }, responseParts: [{ kind: ResponsePartKind.Markdown, id: 's-2#reply', content: 'second answer' }], usage: undefined, state: TurnState.Complete },
						{ id: 's-3', message: { text: 'third question', origin: { kind: MessageKind.User } }, responseParts: [{ kind: ResponsePartKind.Markdown, id: 's-3#reply', content: 'third answer' }], usage: undefined, state: TurnState.Complete },
					],
				},
			});
			const forked = await a.createSession({
				workingDirectories: [URI.file(root)],
				fork: { session: source.session, turnIndex: 1, turnId: 's-2', turnIdMapping: new Map([['s-1', 'f-1'], ['s-2', 'f-2']]) },
			});
			const messages = await a.getSessionMessages(forked.session);
			// Exactly the turns up to the fork point, and none after it.
			assert.deepStrictEqual(messages.map(m => m.message.text), ['first question', 'second question']);
			// Under the host's ids, so the protocol state and this store name the same turns.
			assert.deepStrictEqual(messages.map(m => m.id), ['f-1', 'f-2']);
			const replies = messages.map(m => {
				const reply = m.responseParts.find(p => p.kind === ResponsePartKind.Markdown);
				return reply?.kind === ResponsePartKind.Markdown ? reply.content : undefined;
			});
			assert.deepStrictEqual(replies, ['first answer', 'second answer']);
			// The source is untouched by being forked.
			assert.strictEqual((await a.getSessionMessages(source.session)).length, 3);
		} finally {
			a.dispose();
		}
	});

	test('a fork whose turn id this store does not hold falls back to the index; a source it does not hold inherits nothing and does not throw (#1421)', async () => {
		const a = agent({ SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' });
		try {
			const source = await a.createSession({
				workingDirectories: [URI.file(root)],
				importConversation: {
					turns: [
						{ id: 's-1', message: { text: 'only question', origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete },
						{ id: 's-2', message: { text: 'later question', origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete },
					],
				},
			});
			const byIndex = await a.createSession({
				workingDirectories: [URI.file(root)],
				fork: { session: source.session, turnIndex: 0, turnId: 'not-a-turn-here' },
			});
			assert.deepStrictEqual((await a.getSessionMessages(byIndex.session)).map(m => m.message.text), ['only question']);

			const foreign = await a.createSession({
				workingDirectories: [URI.file(root)],
				fork: { session: AgentSession.uri('someone-else', 'never-stored'), turnIndex: 3, turnId: 'x' },
			});
			assert.deepStrictEqual(await a.getSessionMessages(foreign.session), []);
		} finally {
			a.dispose();
		}
	});
});
