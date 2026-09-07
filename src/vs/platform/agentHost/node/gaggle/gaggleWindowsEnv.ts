/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gaggle 118 — Windows environment parity for the agent host.
 *
 * The agent host resolves its hop and its credential from its inherited process
 * environment. `electronAgentHostStarter` composes that as
 * `{ ...process.env, ...shellEnv }`, and `getResolvedShellEnv` returns `{}` on
 * Windows by design — the login-shell problem it exists to solve does not occur
 * there. The STALENESS problem does: a launching process that started before the
 * operator assigned `SMR_BASE_URL` never carries it, and neither does the agent
 * host, which then reports `hop: none (unconfigured)` beside a healthy router.
 *
 * Worse is a credential that is present but old. An absent endpoint fails closed
 * and says so; a stale key authenticates against the router with something
 * rotated away hours earlier and fails at a distance from its cause.
 *
 * So on Windows only, a NAMED set of variables is re-read from the operating
 * system's assigned environment before the agent host is spawned.
 *
 * Three rules make this safe:
 *  - it can only ever REPLACE a value with the one the OS holds, never blank one
 *    out — absent, empty and unreadable all leave the inherited value alone;
 *  - every failure yields the input unchanged, because a lookup must not be able
 *    to unconfigure a launch that would otherwise have worked;
 *  - it reports which KEYS changed and never a value, a prefix, or a length.
 *    Length is disclosive: comparing 47 against 68 is how the original defect
 *    was diagnosed, which is exactly why the product must not log it.
 */

/**
 * The variables the agent host actually consumes, read off the `gaggle` module
 * rather than assumed. `@vscode/windows-registry` exposes a single named read
 * and cannot enumerate, so this list is explicit by necessity — and by
 * preference, since a blanket refresh could overwrite deliberately-set process
 * variables that have nothing to do with this product.
 *
 * A test asserts every `*_KEY` constant the module reads appears here, so a new
 * dependency cannot fall out of coverage silently.
 */
export const GAGGLE_AGENT_HOST_ENV_KEYS = [
	'SMR_API_KEY',
	'SMR_BASE_URL',
	'SMR_CLOUD_ALLOWED',
	'SMR_DEV_BASE_URL',
	'SMR_HEALTHZ_PATH',
	'SMR_PROD_BASE_URL',
	'SMR_PROFILE_URLS',
	'SMR_REMOTE_API',
	'SOVDB_BASE_URL',
	'SOVDB_CHAT_MEMORY_ARRAY',
] as const;

/**
 * Set to any non-empty value to skip the refresh and use the inherited
 * environment verbatim. Mirrors `--force-disable-user-env`, and for the same
 * reason: a packaged test harness or an operator debugging a second endpoint
 * supplies an environment on purpose, and parity that cannot be turned off
 * converts a fix into a new constraint.
 */
export const GAGGLE_DISABLE_WINDOWS_ENV_REFRESH = 'GAGGLE_DISABLE_WINDOWS_ENV_REFRESH';

/** Where Windows keeps the two scopes it composes into a process environment. */
const HKCU_ENVIRONMENT = 'Environment';
const HKLM_ENVIRONMENT = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

export type RegistryHive = 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE';

/** The one call this needs from `@vscode/windows-registry`; injectable for tests. */
export type RegistryStringReader = (hive: RegistryHive, path: string, name: string) => string | undefined;

export interface GaggleWindowsEnvOptions {
	/** Defaults to `process.platform`. Anything but `win32` is a no-op. */
	readonly platform?: string;
	/** A ready reader, mainly for tests. */
	readonly read?: RegistryStringReader;
	/**
	 * How to obtain a reader when `read` is absent, called ONLY on Windows and
	 * only after the opt-out check.
	 *
	 * The binding lives with the caller rather than here on purpose: the 114
	 * Principle I guard asserts that nothing under `node/gaggle` imports a
	 * scoped package outside `@projectstrataforge`, and that guard is worth more
	 * than the convenience of a default. Supplying neither is fail-closed — the
	 * environment is returned unchanged.
	 */
	readonly loadReader?: () => Promise<RegistryStringReader | undefined>;
	/** Defaults to {@link GAGGLE_AGENT_HOST_ENV_KEYS}. */
	readonly keys?: readonly string[];
}

export interface GaggleWindowsEnvResult {
	/** The environment to spawn with. Identical to the input when nothing changed. */
	readonly env: Record<string, string | undefined>;
	/** The KEYS whose value the OS supplied. Never a value — see the note above. */
	readonly refreshed: readonly string[];
}

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * The OS-assigned value for one name, or undefined.
 *
 * Machine scope is read first and User scope over it, because that is the order
 * Windows itself composes them — a User assignment overriding a Machine one is
 * the operator saying so. Every read is guarded individually: one unreadable
 * name must not abandon the rest.
 */
function assignedValue(read: RegistryStringReader, name: string): string | undefined {
	let value: string | undefined;
	const scopes: readonly (readonly [RegistryHive, string])[] = [
		['HKEY_LOCAL_MACHINE', HKLM_ENVIRONMENT],
		['HKEY_CURRENT_USER', HKCU_ENVIRONMENT],
	];
	for (const [hive, path] of scopes) {
		try {
			const found = nonempty(read(hive, path, name));
			if (found) {
				value = found;
			}
		} catch {
			// A diagnostic lookup must never decide anything. Same discipline as
			// the broker's `peekAccountLabel` and `launch.ts`'s `publish()`.
		}
	}
	return value;
}

/**
 * Compose the agent host's spawn environment on Windows.
 *
 * Returns the input unchanged on every other platform, when the opt-out is set,
 * and whenever the registry cannot be reached at all.
 */
export async function refreshWindowsAgentHostEnv(
	env: Readonly<Record<string, string | undefined>>,
	options?: GaggleWindowsEnvOptions,
): Promise<GaggleWindowsEnvResult> {
	const unchanged = (): GaggleWindowsEnvResult => ({ env: { ...env }, refreshed: [] });

	if ((options?.platform ?? process.platform) !== 'win32') {
		return unchanged();
	}
	if (nonempty(env[GAGGLE_DISABLE_WINDOWS_ENV_REFRESH])) {
		return unchanged();
	}

	let read = options?.read;
	if (!read) {
		try {
			read = await options?.loadReader?.();
		} catch {
			return unchanged();
		}
	}
	if (!read) {
		return unchanged();
	}

	const next: Record<string, string | undefined> = { ...env };
	const refreshed: string[] = [];
	for (const key of options?.keys ?? GAGGLE_AGENT_HOST_ENV_KEYS) {
		const assigned = assignedValue(read, key);
		// Absent, empty or unreadable: an assignment that is not there cannot
		// unconfigure a launch that the inherited environment already configured.
		if (assigned === undefined || next[key] === assigned) {
			continue;
		}
		next[key] = assigned;
		refreshed.push(key);
	}
	return { env: next, refreshed };
}
