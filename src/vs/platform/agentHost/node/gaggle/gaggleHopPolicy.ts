/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gaggle 114 — which SMR hop a turn goes to. This mirrors the Ask chat's policy in
// Gaggle `packages/smr-chat` (`loadConfig` + `selectHop` + `dataPlaneUrl`) member
// for member: configured local Slim first when its health probe answers, otherwise
// the first named remote profile (preferring `remote`), only when cloud is allowed
// or a remote is configured. Dependency-free on purpose: Gaggle's parity test
// imports this file by sibling path and runs both policies over the same
// environments. Endpoint values come from the environment; nothing here is a host.

export const SMR_BASE_URL_KEY = 'SMR_BASE_URL';
export const SMR_HEALTHZ_PATH_KEY = 'SMR_HEALTHZ_PATH';
export const SMR_PROFILE_URLS_KEY = 'SMR_PROFILE_URLS';
export const SMR_REMOTE_API_URL_KEY = 'SMR_REMOTE_API';
export const SMR_DEV_BASE_URL_KEY = 'SMR_DEV_BASE_URL';
export const SMR_PROD_BASE_URL_KEY = 'SMR_PROD_BASE_URL';
export const SMR_CLOUD_ALLOWED_KEY = 'SMR_CLOUD_ALLOWED';

export type GaggleHopEnv = Readonly<Record<string, string | undefined>>;

export interface GaggleHopConfig {
	readonly baseUrl?: string;
	readonly healthzPath?: string;
	readonly profiles: Readonly<Record<string, string>>;
	readonly cloudAllowed: boolean;
}

export interface GaggleResolvedHop {
	readonly kind: 'local' | 'remote';
	/** Profile name: `local`, `remote`, `dev`, `prod`, … */
	readonly profile: string;
	/** Hop origin without a trailing slash (what `normalizeHopBaseUrl` returns). */
	readonly baseUrl: string;
	/** The `/v1`-joined data-plane base the SDK client is constructed with. */
	readonly dataPlaneBaseUrl: string;
	readonly probe: 'ok' | 'failed' | 'skipped';
}

export type GaggleHopFailure = 'unconfigured' | 'local_down_cloud_disallowed' | 'remote_plane_unreachable';

export type GaggleHopResolution =
	| { readonly ok: true; readonly hop: GaggleResolvedHop }
	| { readonly ok: false; readonly reason: GaggleHopFailure };

export interface GaggleHopProbes {
	/** GET `<baseUrl><healthzPath>` → ok? */
	local(url: string): Promise<boolean>;
	/** GET `<dataPlane>/models` → ok, 401 or 403 count as reachable. Optional. */
	remote?(url: string): Promise<boolean>;
}

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** `SMR_PROFILE_URLS` is a JSON object of `{ name: url }`; anything else is ignored. */
export function parseProfiles(raw: string | undefined): Record<string, string> {
	const text = nonempty(raw);
	if (!text) {
		return {};
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string' && value.trim()) {
				out[key] = value.trim();
			}
		}
		return out;
	} catch {
		return {};
	}
}

export function loadHopConfig(env: GaggleHopEnv): GaggleHopConfig {
	const cloudRaw = nonempty(env[SMR_CLOUD_ALLOWED_KEY])?.toLowerCase();
	const remoteApiUrl = nonempty(env[SMR_REMOTE_API_URL_KEY]);
	const profiles = parseProfiles(env[SMR_PROFILE_URLS_KEY]);
	if (remoteApiUrl && !profiles.remote) {
		profiles.remote = remoteApiUrl;
	}
	const devUrl = nonempty(env[SMR_DEV_BASE_URL_KEY]);
	const prodUrl = nonempty(env[SMR_PROD_BASE_URL_KEY]);
	if (devUrl) {
		profiles.dev = devUrl;
	}
	if (prodUrl) {
		profiles.prod = prodUrl;
	}
	return {
		baseUrl: nonempty(env[SMR_BASE_URL_KEY]),
		healthzPath: nonempty(env[SMR_HEALTHZ_PATH_KEY]),
		profiles,
		cloudAllowed: cloudRaw === undefined ? false : cloudRaw === 'true' || cloudRaw === '1',
	};
}

export function normalizeHopBaseUrl(raw: string): string {
	return raw.replace(/\/$/, '');
}

/** Join a data-plane path onto a base that may or may not already end in `/vN`. */
export function dataPlaneUrl(base: string, path: string): string {
	const root = base.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return /\/v\d+$/i.test(root) ? `${root}${suffix}` : `${root}/v1${suffix}`;
}

/** The `/v1` root itself — what the SDK client takes as `baseUrl` (its paths are `chat/completions`, `models`). */
export function dataPlaneBase(base: string): string {
	const root = base.replace(/\/+$/, '');
	return /\/v\d+$/i.test(root) ? root : `${root}/v1`;
}

export function joinUrl(base: string, path: string): string {
	const root = base.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${root}${suffix}`;
}

/**
 * Gaggle 119 — the assigned remote plane, as a protected resource the client can
 * answer for.
 *
 * `required: false` deliberately, and for the reason `[116]` recorded about
 * SovereignDB: a client treats an ABSENT `required` as `true` and refuses
 * `createSession` outright for a resource it cannot authenticate. This resource
 * is declared whenever a remote plane is assigned, but an operator on the LOCAL
 * hop needs no client credential — so requiring it would break local sessions
 * for everyone who also has a remote plane configured.
 *
 * `authorization_servers` carries the same assigned plane, which is how the
 * client resolves a provider for it. Nothing here is invented: no assignment,
 * no resource.
 */
export function remoteSmrResource(
	env: GaggleHopEnv,
): { resource: string; resource_name: string; required: boolean; authorization_servers: string[] } | undefined {
	const config = loadHopConfig(env);
	const named = firstNamedProfile(config);
	if (!named) {
		return undefined;
	}
	const resource = dataPlaneBase(normalizeHopBaseUrl(named.url));
	return {
		resource,
		resource_name: 'Sovereign Model Router',
		required: false,
		authorization_servers: [resource],
	};
}

export function localConfigured(config: GaggleHopConfig): boolean {
	return Boolean(config.baseUrl && config.healthzPath);
}

export function remoteConfigured(config: GaggleHopConfig): boolean {
	return Object.keys(config.profiles).some(name => name !== 'local');
}

export function firstNamedProfile(config: GaggleHopConfig): { name: string; url: string } | undefined {
	const names = Object.keys(config.profiles).filter(n => n !== 'local');
	const name = names.includes('remote') ? 'remote' : names[0];
	return name ? { name, url: config.profiles[name] } : undefined;
}

function remoteHop(named: { name: string; url: string }, probe: GaggleResolvedHop['probe']): GaggleResolvedHop {
	const baseUrl = normalizeHopBaseUrl(named.url);
	return { kind: 'remote', profile: named.name, baseUrl, dataPlaneBaseUrl: dataPlaneBase(baseUrl), probe };
}

async function remoteReachable(url: string, probes: GaggleHopProbes): Promise<boolean> {
	if (!probes.remote) {
		return true;
	}
	try {
		return await probes.remote(dataPlaneUrl(url, '/models'));
	} catch {
		return false;
	}
}

/**
 * Auto-select the hop exactly as the Ask chat does. Credentials are the caller's
 * concern (see `gaggleCredential.ts`); this decides only *where*.
 */
/**
 * Gaggle 121 — the planes an operator may choose, from the ASSIGNMENT alone.
 *
 * `local` appears only when a local endpoint is assigned, and each named
 * profile only when the deployment configured it. An option naming a plane
 * nobody assigned would be an invented endpoint in a dropdown, which is the
 * same rule that keeps hosts out of the product everywhere else.
 */
export function assignedHopProfiles(env: GaggleHopEnv): string[] {
	const config = loadHopConfig(env);
	const options: string[] = [];
	if (localConfigured(config)) {
		options.push('local');
	}
	for (const name of Object.keys(config.profiles)) {
		if (name !== 'local') {
			options.push(name);
		}
	}
	return options;
}

export async function resolveHop(env: GaggleHopEnv, probes: GaggleHopProbes, preference?: string): Promise<GaggleHopResolution> {
	const config = loadHopConfig(env);

	// 121: a named choice goes straight to that plane. Probing the CHOSEN plane
	// is fine; probing local first — a plane the operator did not choose — is
	// exactly what made a connected router unreachable. An absent preference
	// falls through to the local-first path below, unchanged.
	const wanted = preference?.trim();
	if (wanted) {
		if (wanted === 'local') {
			if (!localConfigured(config) || !config.baseUrl || !config.healthzPath) {
				return { ok: false, reason: 'unconfigured' };
			}
			let healthy = false;
			try {
				healthy = await probes.local(joinUrl(config.baseUrl, config.healthzPath));
			} catch {
				healthy = false;
			}
			if (!healthy) {
				// Named, and down. Never quietly answered by a different plane.
				return { ok: false, reason: 'local_down_cloud_disallowed' };
			}
			const baseUrl = normalizeHopBaseUrl(config.baseUrl);
			return { ok: true, hop: { kind: 'local', profile: 'local', baseUrl, dataPlaneBaseUrl: dataPlaneBase(baseUrl), probe: 'ok' } };
		}
		const chosen = config.profiles[wanted];
		if (!chosen) {
			return { ok: false, reason: 'unconfigured' };
		}
		if (!(await remoteReachable(chosen, probes))) {
			return { ok: false, reason: 'remote_plane_unreachable' };
		}
		return { ok: true, hop: remoteHop({ name: wanted, url: chosen }, 'skipped') };
	}

	if (localConfigured(config) && config.baseUrl && config.healthzPath) {
		let healthy = false;
		try {
			healthy = await probes.local(joinUrl(config.baseUrl, config.healthzPath));
		} catch {
			healthy = false;
		}
		if (healthy) {
			const baseUrl = normalizeHopBaseUrl(config.baseUrl);
			return { ok: true, hop: { kind: 'local', profile: 'local', baseUrl, dataPlaneBaseUrl: dataPlaneBase(baseUrl), probe: 'ok' } };
		}
		if (config.cloudAllowed) {
			const named = firstNamedProfile(config);
			if (named) {
				if (!(await remoteReachable(named.url, probes))) {
					return { ok: false, reason: 'remote_plane_unreachable' };
				}
				return { ok: true, hop: remoteHop(named, 'failed') };
			}
		}
		return { ok: false, reason: 'local_down_cloud_disallowed' };
	}
	if (config.cloudAllowed || remoteConfigured(config)) {
		const named = firstNamedProfile(config);
		if (named) {
			if (!(await remoteReachable(named.url, probes))) {
				return { ok: false, reason: 'remote_plane_unreachable' };
			}
			return { ok: true, hop: remoteHop(named, 'skipped') };
		}
	}
	return { ok: false, reason: 'unconfigured' };
}

/** True when any hop is assigned at all — the difference between "no route" copy and a failing probe. */
export function anyHopConfigured(env: GaggleHopEnv): boolean {
	const config = loadHopConfig(env);
	return localConfigured(config) || remoteConfigured(config);
}
