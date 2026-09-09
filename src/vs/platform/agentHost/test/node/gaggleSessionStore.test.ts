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
import { AgentSession } from '../../common/agentService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { GAGGLE_SESSION_FILE, GAGGLE_TURNS_FILE, GaggleSessionStore, titleFromPrompt } from '../../node/gaggle/gaggleSessionStore.js';
import type { GaggleTurnRecord } from '../../node/gaggle/gaggleTypes.js';

// Gaggle 114 — sessions and turns persist under the host's session data dirs and
// reload after a relaunch; a torn trailing write never takes the list down.

function fakeSessionData(root: string): ISessionDataService {
	return {
		_serviceBrand: undefined,
		getSessionDataDir: (session: URI) => URI.file(join(root, AgentSession.id(session).replace(/[^a-zA-Z0-9_.-]/g, '-'))),
		getSessionDataDirById: (id: string) => URI.file(join(root, id)),
		openDatabase: () => { throw new Error('not used'); },
		tryOpenDatabase: async () => undefined,
	} as unknown as ISessionDataService;
}

function turn(turnId: string, prompt: string, reply: string): GaggleTurnRecord {
	return { turnId, startedAt: new Date().toISOString(), durationMs: 5, prompt, replyMarkdown: reply, state: 'complete' };
}

suite('gaggleSessionStore (114)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let store: GaggleSessionStore;
	setup(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), 'gaggle-store-'));
		store = new GaggleSessionStore(fakeSessionData(root), new NullLogService());
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('title is the first prompt line, capped at 80 characters, never the whole prompt', () => {
		assert.strictEqual(titleFromPrompt('\n\n  hello there  \nsecond line'), 'hello there');
		const long = 'x'.repeat(200);
		assert.strictEqual(titleFromPrompt(long).length, 80);
		assert.ok(titleFromPrompt(long).endsWith('…'));
	});

	test('create → append turns → relaunch (new store) → list + replay', async () => {
		const session = AgentSession.uri('gaggle', 'abc-123');
		await store.create(session, { sessionId: 'abc-123', createdAt: new Date().toISOString(), folder: root });
		await store.appendTurn(session, turn('t1', 'ping', 'pong'));
		await store.appendTurn(session, turn('t2', 'again', 'pong again'));

		const relaunched = new GaggleSessionStore(fakeSessionData(root), new NullLogService());
		const listed = await relaunched.list();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].session.toString(), session.toString());
		assert.strictEqual(listed[0].folderMissing, false);
		const turns = await relaunched.readTurns(session);
		assert.deepStrictEqual(turns.map(t => t.turnId), ['t1', 't2']);
		assert.strictEqual(turns[1].replyMarkdown, 'pong again');
	});

	test('a corrupt trailing line is dropped, the earlier turns survive', async () => {
		const session = AgentSession.uri('gaggle', 'torn');
		await store.create(session, { sessionId: 'torn', createdAt: new Date().toISOString() });
		await store.appendTurn(session, turn('t1', 'ping', 'pong'));
		const file = join(root, 'torn', GAGGLE_TURNS_FILE);
		fs.appendFileSync(file, '{"turnId":"t2","prompt":"half wri');
		const turns = await store.readTurns(session);
		assert.deepStrictEqual(turns.map(t => t.turnId), ['t1']);
	});

	test('a session whose folder is gone still lists, marked', async () => {
		const session = AgentSession.uri('gaggle', 'gone');
		await store.create(session, { sessionId: 'gone', createdAt: new Date().toISOString(), folder: join(root, 'does-not-exist') });
		const listed = await store.list();
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].folderMissing, true);
	});

	test('directories without a gaggle session file are not ours', async () => {
		fs.mkdirSync(join(root, 'copilot-session'), { recursive: true });
		fs.writeFileSync(join(root, 'copilot-session', 'other.json'), '{}');
		assert.deepStrictEqual(await store.list(), []);
	});

	test('seedTurns writes the carry in one shot and survives a relaunch', async () => {
		const session = AgentSession.uri('gaggle', 'carried');
		await store.create(session, { sessionId: 'carried', createdAt: new Date().toISOString(), carriedFrom: '/repos/alpha' });
		await store.seedTurns(session, [
			{ ...turn('t1', 'what did we decide', 'a handoff'), carried: true, folder: '/repos/alpha' },
			{ ...turn('t2', 'and then', 'the model must see it'), carried: true, folder: '/repos/alpha' },
		]);
		const file = join(root, 'carried', GAGGLE_TURNS_FILE);
		assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
		const relaunched = new GaggleSessionStore(fakeSessionData(root), new NullLogService());
		const turns = await relaunched.readTurns(session);
		assert.deepStrictEqual(turns.map(t => [t.turnId, t.carried, t.folder]), [
			['t1', true, '/repos/alpha'],
			['t2', true, '/repos/alpha'],
		]);
		assert.strictEqual((await relaunched.read(session))?.carriedFrom, '/repos/alpha');
	});

	test('update patches the record; remove deletes the directory', async () => {
		const session = AgentSession.uri('gaggle', 'upd');
		await store.create(session, { sessionId: 'upd', createdAt: new Date().toISOString() });
		const next = await store.update(session, { title: 'first line', modelId: 'm1' });
		assert.strictEqual(next?.title, 'first line');
		assert.strictEqual((await store.read(session))?.modelId, 'm1');
		assert.ok(fs.existsSync(join(root, 'upd', GAGGLE_SESSION_FILE)));
		await store.remove(session);
		assert.ok(!fs.existsSync(join(root, 'upd')));
	});
});
