/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	GAGGLE_AGENT_HOST_ENV_KEYS,
	GAGGLE_DISABLE_WINDOWS_ENV_REFRESH,
	refreshWindowsAgentHostEnv,
	type RegistryHive,
	type RegistryStringReader,
} from '../../node/gaggle/gaggleWindowsEnv.js';

// Gaggle 118 — the agent host must see the environment the OPERATING SYSTEM
// holds, not whatever stale block the launching process happened to carry. The
// negatives carry the weight: it must never invent a value, never blank one out,
// never fail a launch, and never disclose a credential — including its length.

const HKLM = 'HKEY_LOCAL_MACHINE';
const HKCU = 'HKEY_CURRENT_USER';

/** A registry whose contents the test states outright, keyed `hive|name`. */
function registry(values: Record<string, string>, onRead?: (name: string) => void): RegistryStringReader {
	return (hive: RegistryHive, _path: string, name: string) => {
		onRead?.(name);
		return values[`${hive}|${name}`];
	};
}

/** Windows, with an injected registry — so every case runs on any CI platform. */
function onWindows(read: RegistryStringReader, keys?: readonly string[]) {
	return { platform: 'win32', read, keys };
}

suite('Gaggle 118 — Windows agent-host environment parity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an assignment the launching process never carried reaches the agent host', async () => {
		// The observed failure: SMR_BASE_URL and SMR_HEALTHZ_PATH assigned in the
		// User environment, absent from the process, so the hop read as unconfigured.
		const read = registry({
			[`${HKCU}|SMR_BASE_URL`]: 'http://127.0.0.1:8000',
			[`${HKCU}|SMR_HEALTHZ_PATH`]: '/healthz',
		});
		const result = await refreshWindowsAgentHostEnv({ PATH: 'C:\\Windows' }, onWindows(read));

		assert.deepStrictEqual(result, {
			env: {
				PATH: 'C:\\Windows',
				SMR_BASE_URL: 'http://127.0.0.1:8000',
				SMR_HEALTHZ_PATH: '/healthz',
			},
			refreshed: ['SMR_BASE_URL', 'SMR_HEALTHZ_PATH'],
		});
	});

	test('a rotated credential wins over the stale one the process inherited', async () => {
		// The dangerous case: present, and wrong. An absent endpoint fails closed
		// and says so; a stale key authenticates and fails at a distance.
		const read = registry({ [`${HKCU}|SMR_API_KEY`]: 'rotated-value' });
		const result = await refreshWindowsAgentHostEnv({ SMR_API_KEY: 'stale-value' }, onWindows(read));

		assert.deepStrictEqual(result, {
			env: { SMR_API_KEY: 'rotated-value' },
			refreshed: ['SMR_API_KEY'],
		});
	});

	test('a User assignment overrides a Machine one, as Windows itself composes them', async () => {
		const read = registry({
			[`${HKLM}|SMR_BASE_URL`]: 'http://machine-scope:8000',
			[`${HKCU}|SMR_BASE_URL`]: 'http://user-scope:8000',
		});
		const result = await refreshWindowsAgentHostEnv({}, onWindows(read));
		assert.strictEqual(result.env.SMR_BASE_URL, 'http://user-scope:8000');
	});

	test('a Machine assignment is used when the user has none', async () => {
		const read = registry({ [`${HKLM}|SMR_BASE_URL`]: 'http://machine-scope:8000' });
		const result = await refreshWindowsAgentHostEnv({}, onWindows(read));
		assert.strictEqual(result.env.SMR_BASE_URL, 'http://machine-scope:8000');
	});

	test('absent, empty and whitespace assignments leave the inherited value alone', async () => {
		// An assignment that is not there must not be able to unconfigure a launch
		// the inherited environment had already configured.
		const read = registry({
			[`${HKCU}|SMR_BASE_URL`]: '',
			[`${HKCU}|SMR_API_KEY`]: '   ',
		});
		const inherited = { SMR_BASE_URL: 'http://inherited:8000', SMR_API_KEY: 'inherited-key' };
		const result = await refreshWindowsAgentHostEnv(inherited, onWindows(read));

		assert.deepStrictEqual(result, { env: inherited, refreshed: [] });
	});

	test('nothing is invented — an unassigned endpoint stays unassigned', async () => {
		const result = await refreshWindowsAgentHostEnv({}, onWindows(registry({})));
		assert.deepStrictEqual(result, { env: {}, refreshed: [] }, 'nothing assigned, nothing invented');
	});

	test('a throwing registry cannot unconfigure a launch', async () => {
		const exploding: RegistryStringReader = () => { throw new Error('registry unavailable'); };
		const inherited = { SMR_BASE_URL: 'http://inherited:8000' };
		const result = await refreshWindowsAgentHostEnv(inherited, onWindows(exploding));

		assert.deepStrictEqual(result, { env: inherited, refreshed: [] });
	});

	test('the opt-out skips the refresh entirely and never touches the registry', async () => {
		// The packaged e2e suites launch with an explicit environment on purpose.
		const seen: string[] = [];
		const read = registry({ [`${HKCU}|SMR_BASE_URL`]: 'http://assigned:8000' }, name => seen.push(name));
		const inherited = {
			[GAGGLE_DISABLE_WINDOWS_ENV_REFRESH]: '1',
			SMR_BASE_URL: 'http://explicitly-set:9000',
		};
		const result = await refreshWindowsAgentHostEnv(inherited, onWindows(read));

		assert.deepStrictEqual(result, { env: inherited, refreshed: [] });
		assert.deepStrictEqual(seen, [], 'the registry must not be read at all');
	});

	test('with no way to read the registry, the environment is returned unchanged', async () => {
		// The binding lives with the caller so `node/gaggle` imports no scoped
		// package (the 114 Principle I guard). A caller that supplies neither a
		// reader nor a loader must therefore fail closed, not throw.
		const inherited = { SMR_BASE_URL: 'http://inherited:8000' };
		const result = await refreshWindowsAgentHostEnv(inherited, { platform: 'win32' });

		assert.deepStrictEqual(result, { env: inherited, refreshed: [] });
	});

	test('darwin and linux are untouched, and never reach the registry', async () => {
		const seen: string[] = [];
		const read = registry({ [`${HKCU}|SMR_BASE_URL`]: 'http://assigned:8000' }, name => seen.push(name));
		for (const platform of ['darwin', 'linux']) {
			const inherited = { SMR_BASE_URL: 'http://inherited:8000', PATH: '/usr/bin' };
			const result = await refreshWindowsAgentHostEnv(inherited, { platform, read });

			assert.deepStrictEqual(result.env, inherited, `${platform} must be byte-identical`);
			assert.deepStrictEqual(result.refreshed, []);
		}
		assert.deepStrictEqual(seen, [], 'no platform but win32 may read the registry');
	});

	test('the refreshed report names keys and never discloses a value or its length', async () => {
		// Length is disclosive: comparing 47 against 68 is how the original defect
		// was diagnosed, which is precisely why the product must not report it.
		const secret = 'a-credential-nobody-should-see';
		const read = registry({ [`${HKCU}|SMR_API_KEY`]: secret });
		const result = await refreshWindowsAgentHostEnv({ SMR_API_KEY: 'old' }, onWindows(read));

		const reported = result.refreshed.join(' ');
		assert.strictEqual(reported, 'SMR_API_KEY');
		assert.ok(!reported.includes(secret), 'no value');
		assert.ok(!/\d/.test(reported), 'no length, and nothing numeric to infer one from');
	});

	test('the named set covers every environment key the agent host reads', async () => {
		// The drift guard: read the gaggle module rather than restating its list,
		// so a variable a future change starts depending on cannot fall out of
		// coverage silently.
		// Resolved from this file, so it works from `out/` as well as from source
		// (the same `import.meta.url` shape agentService.test.ts uses), and it
		// scans whichever extension the layout built.
		const here = fileURLToPath(new URL('.', import.meta.url)).replace(/[\/]$/, '');
		const dir = join(here, '..', '..', 'node', 'gaggle');
		const sources = fs.readdirSync(dir).filter(name =>
			/^gaggle.*\.(ts|js)$/.test(name) && !name.startsWith('gaggleWindowsEnv.'));
		assert.ok(sources.length > 0, `the scan must find the gaggle module, looked in ${dir}`);

		const found = new Set<string>();
		for (const name of sources) {
			const text = fs.readFileSync(join(dir, name), 'utf8');
			// Either quote style: the sources use single quotes, and the compiled
			// output this runs against normalises them to double.
			for (const match of text.matchAll(/["']((?:SMR|SOVDB)_[A-Z0-9_]+)["']/g)) {
				found.add(match[1]);
			}
		}
		assert.ok(found.size > 0, 'the scan must find environment keys, or it is asserting nothing');

		const covered = new Set<string>(GAGGLE_AGENT_HOST_ENV_KEYS);
		const missing = [...found].filter(key => !covered.has(key)).sort();
		assert.deepStrictEqual(
			missing,
			[],
			`the agent host reads these and the refresh set does not carry them: ${missing.join(', ')}`,
		);
	});
});
