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
import { ISessionDataService } from '../../common/sessionDataService.js';
import { GaggleAgent } from '../../node/gaggle/gaggleAgent.js';
import { remoteSmrResource } from '../../node/gaggle/gaggleHopPolicy.js';
import { resolveCredential } from '../../node/gaggle/gaggleCredential.js';

// Gaggle 119 — the agent host had ONE key for every plane, so it presented the
// workstation's local seed key to the remote plane and was refused. These
// assert the credential now arrives from the client, and — the part that
// matters more — that it can only ever go back to the plane it was issued for.

const PROD = 'https://router.example.test/v1';
const DEV = 'https://router-dev.example.test/v1';

function fakeSessionData(root: string): ISessionDataService {
	return {
		_serviceBrand: undefined,
		getSessionDataDir: (session: URI) => URI.file(join(root, session.path.replace(/[^a-zA-Z0-9_.-]/g, '-'))),
		getSessionDataDirById: (id: string) => URI.file(join(root, id)),
		openDatabase: () => { throw new Error('not used'); },
		tryOpenDatabase: async () => undefined,
	} as unknown as ISessionDataService;
}

function agentWith(env: Record<string, string | undefined>): GaggleAgent {
	const root = fs.mkdtempSync(join(os.tmpdir(), 'gaggle-119-'));
	return new GaggleAgent(
		{ env, fetch: (async () => ({ ok: false, status: 500 })) as never, hopTtlMs: 0 },
		new NullLogService(),
		fakeSessionData(root),
	);
}

suite('Gaggle 119 — a remote credential the agent host can present', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the assigned remote plane is declared, and nothing is declared without one', () => {
		assert.deepStrictEqual(remoteSmrResource({ SMR_PROD_BASE_URL: PROD }), {
			resource: PROD,
			resource_name: 'Sovereign Model Router',
			// 116's lesson, not re-learned: an absent `required` reads as true and
			// would refuse createSession for an operator on the local hop.
			required: false,
			authorization_servers: [PROD],
		});
		assert.strictEqual(remoteSmrResource({}), undefined, 'no assignment, nothing declared');
		assert.strictEqual(
			remoteSmrResource({ SMR_BASE_URL: 'http://127.0.0.1:8000' }),
			undefined,
			'a local assignment is not a remote plane',
		);
	});

	test('a console-root assignment is declared as the data plane', () => {
		// The operator may save the console root; the resource must still name the
		// plane the SDK will actually call.
		assert.strictEqual(
			remoteSmrResource({ SMR_PROD_BASE_URL: 'https://router.example.test' })?.resource,
			PROD,
		);
	});

	test('a bearer is accepted for the declared plane and refused for anything else', async () => {
		const agent = agentWith({ SMR_PROD_BASE_URL: PROD });
		try {
			assert.strictEqual(await agent.authenticate(PROD, 'issued-for-prod'), true);
			assert.strictEqual(
				await agent.authenticate('https://somewhere-else.example.test/v1', 'not-ours'),
				false,
				'an undeclared resource must be refused, not quietly accepted',
			);
		} finally {
			agent.dispose();
		}
	});

	test('the declared resources cover both planes the agent depends on', () => {
		const agent = agentWith({ SMR_PROD_BASE_URL: PROD, SOVDB_BASE_URL: 'https://sovdb.example.test' });
		try {
			assert.deepStrictEqual(
				agent.getProtectedResources().map(r => r.resource_name).sort(),
				['Sovereign Model Router', 'SovereignDB'],
			);
		} finally {
			agent.dispose();
		}
	});

	test('the local hop takes the assigned key, never a client-supplied bearer', () => {
		// `resolveCredential` is the seam: a token provider wins ONLY for remote.
		const env = { SMR_API_KEY: 'assigned-local-key' };
		assert.deepStrictEqual(resolveCredential(env, 'local', () => 'client-bearer'), {
			apiKey: 'assigned-local-key',
		});
	});

	test('a remote hop with a client bearer uses it, and without one falls back honestly', () => {
		const env = { SMR_API_KEY: 'assigned-local-key' };
		// Asserted behaviourally rather than with `in` (the vendor lint bans it),
		// which is stronger anyway: the provider is present AND yields the bearer.
		const withProvider = resolveCredential(env, 'remote', () => 'client-bearer') as
			{ tokenProvider?: () => string } | undefined;
		assert.strictEqual(withProvider?.tokenProvider?.(), 'client-bearer', 'the client bearer wins for remote');

		// No provider: the assigned key is still returned, and the plane refuses it.
		// That refusal is the honest failure this feature replaced a stub with — it
		// must stay legible rather than being flattened into "unconfigured".
		assert.deepStrictEqual(resolveCredential(env, 'remote', undefined), { apiKey: 'assigned-local-key' });
		assert.strictEqual(resolveCredential({}, 'remote', undefined), undefined, 'nothing assigned, nothing invented');
	});

	test('nothing in the declared resource carries credential material', () => {
		const declared = JSON.stringify(remoteSmrResource({ SMR_PROD_BASE_URL: PROD, SMR_API_KEY: 'a-secret-key-value' }));
		assert.ok(!declared.includes('a-secret-key-value'), 'no credential in the declaration');
		assert.ok(!/\beyJ[\w-]+\.[\w-]+/.test(declared), 'no JWT');
	});

	test('two planes are never confused: dev and prod declare different resources', () => {
		// Order-based selection is what sent auto-hop to dev instead of the prod the
		// operator had signed into. The resource is what disambiguates.
		const prod = remoteSmrResource({ SMR_PROD_BASE_URL: PROD })?.resource;
		const dev = remoteSmrResource({ SMR_DEV_BASE_URL: DEV })?.resource;
		assert.strictEqual(prod, PROD);
		assert.strictEqual(dev, DEV);
		assert.notStrictEqual(prod, dev);
	});
});
