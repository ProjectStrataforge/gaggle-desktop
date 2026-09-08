/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { assignedHopProfiles, resolveHop, type GaggleHopProbes } from '../../node/gaggle/gaggleHopPolicy.js';

// Gaggle 121 — a healthy local endpoint used to make an assigned remote plane
// unreachable, and the local Slim only ever stubs. These assert the operator
// can say otherwise, that saying nothing changes nothing, and — the part that
// matters most — that a choice which cannot be served is REFUSED BY NAME rather
// than quietly answered by a different plane.

const LOCAL = { SMR_BASE_URL: 'http://127.0.0.1:8000', SMR_HEALTHZ_PATH: '/healthz' };
const PROD = { SMR_PROD_BASE_URL: 'https://router.example.test/v1' };

/** Local healthy or not; remote reachable or not. Nothing else matters here. */
function probes(localOk: boolean, remoteOk = true): GaggleHopProbes {
	return { local: async () => localOk, remote: async () => remoteOk };
}

suite('Gaggle 121 — the session chooses its SMR plane', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the options are the ASSIGNED planes, and nothing else', () => {
		assert.deepStrictEqual(assignedHopProfiles({ ...LOCAL, ...PROD }).sort(), ['local', 'prod']);
		assert.deepStrictEqual(assignedHopProfiles(LOCAL), ['local']);
		assert.deepStrictEqual(assignedHopProfiles(PROD), ['prod']);
		// Nothing assigned: no options at all. An entry naming a plane nobody
		// assigned would be an invented endpoint in a dropdown.
		assert.deepStrictEqual(assignedHopProfiles({}), []);
	});

	test('a chosen remote plane is used even though local is healthy', async () => {
		// The whole feature: before this, a healthy local endpoint made the
		// assigned router unreachable, and local only ever answers with a stub.
		const resolution = await resolveHop({ ...LOCAL, ...PROD }, probes(true), 'prod');
		assert.ok(resolution.ok);
		assert.strictEqual(resolution.hop.kind, 'remote');
		assert.strictEqual(resolution.hop.profile, 'prod');
	});

	test('choosing local keeps local, even when a remote plane is assigned', async () => {
		const resolution = await resolveHop({ ...LOCAL, ...PROD }, probes(true), 'local');
		assert.ok(resolution.ok);
		assert.strictEqual(resolution.hop.kind, 'local');
	});

	test('a chosen plane that cannot be reached is refused, never substituted', async () => {
		// Remote chosen and unreachable: it must NOT quietly fall back to the
		// healthy local endpoint. Silent substitution is the defect class this
		// whole feature exists to remove.
		const remoteDown = await resolveHop({ ...LOCAL, ...PROD }, probes(true, false), 'prod');
		assert.deepStrictEqual(remoteDown, { ok: false, reason: 'remote_plane_unreachable' });

		// Local chosen and down: it must NOT reach for the remote plane.
		const localDown = await resolveHop({ ...LOCAL, ...PROD }, probes(false), 'local');
		assert.deepStrictEqual(localDown, { ok: false, reason: 'local_down_cloud_disallowed' });
	});

	test('a plane the deployment never assigned is refused, not reinterpreted', async () => {
		assert.deepStrictEqual(
			await resolveHop({ ...LOCAL, ...PROD }, probes(true), 'staging'),
			{ ok: false, reason: 'unconfigured' },
		);
		assert.deepStrictEqual(
			await resolveHop(PROD, probes(true), 'local'),
			{ ok: false, reason: 'unconfigured' },
			'local is not assigned here',
		);
	});

	test('NO preference is byte-identical to the local-first default', async () => {
		// The guard on the whole feature: an operator who never touches this must
		// get exactly what they got before, including failure reasons.
		const healthy = await resolveHop({ ...LOCAL, ...PROD }, probes(true));
		assert.ok(healthy.ok);
		assert.strictEqual(healthy.hop.kind, 'local', 'local-first is still the default');

		// Local down, cloud not allowed: the existing refusal, unchanged.
		assert.deepStrictEqual(
			await resolveHop({ ...LOCAL, ...PROD }, probes(false)),
			{ ok: false, reason: 'local_down_cloud_disallowed' },
		);

		// Local down WITH cloud allowed: the existing fallback, unchanged.
		const fellBack = await resolveHop({ ...LOCAL, ...PROD, SMR_CLOUD_ALLOWED: 'true' }, probes(false));
		assert.ok(fellBack.ok);
		assert.strictEqual(fellBack.hop.kind, 'remote');

		// Nothing assigned: unchanged.
		assert.deepStrictEqual(await resolveHop({}, probes(true)), { ok: false, reason: 'unconfigured' });
	});

	test('an empty or whitespace preference means no preference', async () => {
		for (const blank of ['', '   ']) {
			const resolution = await resolveHop({ ...LOCAL, ...PROD }, probes(true), blank);
			assert.ok(resolution.ok);
			assert.strictEqual(resolution.hop.kind, 'local', `"${blank}" must not be treated as a choice`);
		}
	});

	test('no option or refusal carries a credential', async () => {
		const env = { ...LOCAL, ...PROD, SMR_API_KEY: 'a-secret-key-value' };
		const options = JSON.stringify(assignedHopProfiles(env));
		assert.ok(!options.includes('a-secret-key-value'));
		// Options are NAMES, not URLs — nothing to leak and nothing to mistake
		// for an endpoint the deployment did not assign.
		assert.deepStrictEqual(JSON.parse(options).sort(), ['local', 'prod']);

		const refused = JSON.stringify(await resolveHop(env, probes(true, false), 'prod'));
		assert.ok(!refused.includes('a-secret-key-value'));
	});
});
