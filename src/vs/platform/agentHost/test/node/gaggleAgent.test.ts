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
});
