/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tableFromIPC } from 'apache-arrow';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import {
	GaggleSovereignDbMemoryBridge,
	checkMemoryPayload,
	classifyMemoryDestination,
	fragmentFromTurn,
	piiExternalApproved,
	sovereignDbResource,
	type GaggleEmbedPort,
	type GaggleMemoryClient,
} from '../../node/gaggle/gaggleSovereignDbMemoryBridge.js';
import type { GaggleTurnRecord } from '../../node/gaggle/gaggleTypes.js';

const BASE = 'https://sovereigndb.example';

function turn(overrides: Partial<GaggleTurnRecord> = {}): GaggleTurnRecord {
	return {
		turnId: 'turn-1',
		startedAt: '2026-09-06T12:00:00.000Z',
		durationMs: 12,
		prompt: 'what did we decide about the hop policy?',
		replyMarkdown: 'Local first, then the assigned remote.',
		attribution: { hop: 'local', servedModel: 'gpt-4o-mini', fallbackChain: [] },
		state: 'complete',
		...overrides,
	};
}

/** A fake SovereignDB that records what it was asked to do. */
function fakeClient(rows: Record<string, unknown>[] = []): GaggleMemoryClient & {
	readonly writes: { name: string; bytes: Uint8Array }[];
	readonly reads: { name: string; query: unknown }[];
} {
	const writes: { name: string; bytes: Uint8Array }[] = [];
	const reads: { name: string; query: unknown }[] = [];
	return {
		writes,
		reads,
		writeFragments: (async (name: string, bytes: Uint8Array) => {
			writes.push({ name, bytes });
			return { raw: {} };
		}) as GaggleMemoryClient['writeFragments'],
		similarity: (async (name: string, query: unknown) => {
			reads.push({ name, query });
			return { rows: <T,>() => rows as T[] };
		}) as unknown as GaggleMemoryClient['similarity'],
	};
}

const goodEmbedder: GaggleEmbedPort = { embed: async () => ({ ok: true, vector: [0.25, 0.5, 0.75, 1] }) };
const noEmbedder: GaggleEmbedPort = { embed: async () => ({ ok: false, reason: 'no embedder assigned' }) };

function bridge(options: {
	env?: Record<string, string | undefined>;
	client?: GaggleMemoryClient;
	embedder?: GaggleEmbedPort;
	intent?: { class: string; status: string; id: string };
} = {}) {
	return new GaggleSovereignDbMemoryBridge({
		env: options.env ?? { SOVDB_BASE_URL: BASE, SOVDB_CHAT_MEMORY_ARRAY: 'gaggle_chat_memory' },
		client: options.client ?? fakeClient(),
		embedder: options.embedder ?? goodEmbedder,
		logService: new NullLogService(),
		...(options.intent ? { intent: options.intent } : {}),
	});
}

suite('Gaggle SovereignDB memory bridge (114 US3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('declares the ASSIGNED SovereignDB as an OAuth protected resource, and nothing when none is assigned', () => {
		assert.deepStrictEqual(sovereignDbResource({ SOVDB_BASE_URL: `${BASE}/` }), {
			resource: BASE,
			resource_name: 'SovereignDB',
			// 116: memory is BEST EFFORT. A client treats an absent `required` as
			// true and refuses createSession for a resource it cannot authenticate,
			// which made every session fail wherever SOVDB_BASE_URL was assigned.
			required: false,
		});
		assert.deepStrictEqual(
			[sovereignDbResource({}), sovereignDbResource({ SOVDB_BASE_URL: '   ' })],
			[undefined, undefined],
		);
	});

	test('is off, and writes nothing, when no SovereignDB is assigned', async () => {
		const client = fakeClient();
		const off = bridge({ env: {}, client });
		assert.strictEqual(off.enabled, false);
		assert.deepStrictEqual(await off.retrieve('anything', 3), []);
		await off.capture(turn());
		assert.deepStrictEqual([client.writes.length, client.reads.length], [0, 0]);
	});

	test('classifies only the assigned SovereignDB as a sanctioned destination', () => {
		assert.deepStrictEqual(
			[
				classifyMemoryDestination(BASE, BASE),
				classifyMemoryDestination(`${BASE}/`, BASE),
				classifyMemoryDestination('https://elsewhere.example', BASE),
				classifyMemoryDestination(undefined, BASE),
				classifyMemoryDestination(BASE, undefined),
			],
			['sovereigndb', 'sovereigndb', 'unsanctioned', 'unsanctioned', 'unsanctioned'],
		);
	});

	test('the gate refuses an unsanctioned destination and unapproved external PII', () => {
		const applied = { class: 'pii_external', status: 'applied', id: 'intent-1' };
		const notice = (destination: string, carriesPiiForExternalHop: boolean, intent?: typeof applied) =>
			checkMemoryPayload({ destination, assignedBaseUrl: BASE, carriesPiiForExternalHop, intent }).notice;
		assert.deepStrictEqual(
			[
				notice('https://elsewhere.example', false),
				notice(BASE, true),
				notice(BASE, true, applied),
				notice(BASE, false),
			],
			['payload_denied', 'pii_external_refused', 'payload_allowed', 'payload_allowed'],
		);
		assert.strictEqual(piiExternalApproved(applied), true);
		assert.strictEqual(piiExternalApproved({ class: 'pii_external', status: 'draft', id: 'i' }), false);
	});

	test('a refused record is NOT written', async () => {
		const client = fakeClient();
		// A remote-served turn without a lead-applied approval.
		await bridge({ client }).capture(turn({ attribution: { hop: 'remote', servedModel: 'sol', fallbackChain: [] } }));
		assert.strictEqual(client.writes.length, 0);
	});

	test('an approved external turn IS written', async () => {
		const client = fakeClient();
		const approved = bridge({ client, intent: { class: 'pii_external', status: 'applied', id: 'intent-1' } });
		await approved.capture(turn({ attribution: { hop: 'remote', servedModel: 'sol', fallbackChain: [] } }));
		assert.deepStrictEqual(
			[client.writes.length, client.writes[0]?.name, client.writes[0]!.bytes.byteLength > 0],
			[1, 'gaggle_chat_memory', true],
		);
	});

	test('a local turn is captured to the configured array as an Arrow stream', async () => {
		const client = fakeClient();
		await bridge({ client }).capture(turn());
		assert.deepStrictEqual([client.writes.length, client.writes[0]?.name], [1, 'gaggle_chat_memory']);
		// Arrow IPC stream framing: a continuation marker, not JSON.
		assert.deepStrictEqual(Array.from(client.writes[0]!.bytes.subarray(0, 4)), [255, 255, 255, 255]);
	});

	test('retrieve returns citations built from the provenance columns', async () => {
		const client = fakeClient([
			{ session_id: 's-1', title: 'hop policy', snippet: 'local first', source: 'local:gpt-4o-mini' },
			{ session_id: 's-2', title: '', snippet: 'then the assigned remote' },
		]);
		const citations = await bridge({ client }).retrieve('hop policy?', 2);
		assert.deepStrictEqual(citations, [
			{ id: 's-1', title: 'hop policy', snippet: 'local first', source: 'local:gpt-4o-mini' },
			{ id: 's-2', title: 's-2', snippet: 'then the assigned remote' },
		]);
		assert.deepStrictEqual(client.reads[0]?.name, 'gaggle_chat_memory');
	});

	test('no assigned embedder means no retrieval and no write — never a synthetic vector', async () => {
		const client = fakeClient([{ session_id: 's-1', title: 't', snippet: 's' }]);
		const failClosed = bridge({ client, embedder: noEmbedder });
		assert.deepStrictEqual(await failClosed.retrieve('anything', 3), []);
		await failClosed.capture(turn());
		assert.deepStrictEqual([client.reads.length, client.writes.length], [0, 0]);
	});

	test('an unreachable SovereignDB degrades to no memory rather than breaking the turn', async () => {
		const unreachable: GaggleMemoryClient = {
			writeFragments: (async () => {
				throw new Error('ECONNREFUSED https://sovereigndb.example');
			}) as GaggleMemoryClient['writeFragments'],
			similarity: (async () => {
				throw new Error('ECONNREFUSED https://sovereigndb.example');
			}) as unknown as GaggleMemoryClient['similarity'],
		};
		const down = bridge({ client: unreachable });
		assert.deepStrictEqual(await down.retrieve('anything', 3), []);
		// Must not throw into the turn.
		await down.capture(turn());
	});

	test('the fragment carries the DIMENSION column and a FixedSizeList vector', () => {
		// Both learned from a live SovereignDB, and both were missing before it was
		// run: a fragment without the array's dimension column is refused, and the
		// vector must be FixedSizeList<Float32>[width] — `tableFromArrays` builds a
		// List from a nested array, which is a different type and is refused.
		const bytes = fragmentFromTurn(turn(), [0.1, 0.2, 0.3, 0.4]);
		const table = tableFromIPC(bytes);
		const byName = Object.fromEntries(table.schema.fields.map(f => [f.name, String(f.type)]));
		assert.deepStrictEqual(byName, {
			x: 'Int32',
			embedding: 'FixedSizeList[4]<Float32>',
			session_id: 'Utf8',
			title: 'Utf8',
			snippet: 'Utf8',
			source: 'Utf8',
			captured_at: 'Int64',
		});
		assert.strictEqual(table.numRows, 1);
	});

	test('the same turn always lands on the same coordinate', () => {
		const a = tableFromIPC(fragmentFromTurn(turn(), [0.1])).getChild('x')?.get(0);
		const b = tableFromIPC(fragmentFromTurn(turn(), [0.9])).getChild('x')?.get(0);
		const other = tableFromIPC(fragmentFromTurn(turn({ turnId: 'turn-2' }), [0.1])).getChild('x')?.get(0);
		assert.strictEqual(a, b, 'a re-captured turn must not grow the array');
		assert.notStrictEqual(a, other, 'different turns must not collide');
		assert.ok(typeof a === 'number' && a >= 0 && a < 10_000_000, `coordinate ${a} is outside the array domain`);
	});
});
