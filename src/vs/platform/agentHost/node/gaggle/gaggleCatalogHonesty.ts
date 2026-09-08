/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gaggle 120 — catalogue honesty for the agent host.
 *
 * Adapted with attribution from the Gaggle overlay's `[101]`/`[102]` work:
 * `apps/desktop/src/chrome/catalog-honesty.ts` and `model-route.ts`. The fork
 * cannot import overlay chrome, so this is adapt-with-attribution rather than
 * consume-as-package (estate reuse directive). Keep the id lists in step with
 * the overlay copy; if they drift, they drift visibly in both places.
 *
 * The point: a catalogue NAME is not proof that a model answers. `router-default`
 * is measured-real on an assigned remote plane and stubs on the local Slim, so
 * "Auto" must resolve by measured behaviour, never by matching a name.
 *
 * Issue 138 stays CLOSED.
 */

/**
 * Ids measured to return a real completion.
 *
 * CAVEAT, measured 2026-09-07: these were measured against an assigned REMOTE
 * plane. The stub is a property of the PLANE as much as the model — a packaged
 * turn on the LOCAL hop returned `model=router-default … latency_ms=0`, the stub
 * signature, for an id on this list. So treat the list as "can be real on a
 * remote plane", never as a guarantee for whichever plane is selected. That is
 * why `pickCatalogId` chooses a PREFERENCE and the caller keeps a fallback,
 * rather than this list gating whether a turn may run at all.
 */
export const MEASURED_REAL_IDS = [
	'sol',
	'terra',
	'luna',
	'mini',
	'nano',
	'router-default',
] as const;

/** Ids measured to return the deterministic stub (`latency_ms=0`). */
export const MEASURED_STUB_IDS = ['gpt-4o-mini', 'claude-sonnet-4-6'] as const;

export type CatalogIdKind = 'measured-real' | 'measured-stub' | 'unknown';

export function catalogIdKind(id: string): CatalogIdKind {
	if ((MEASURED_STUB_IDS as readonly string[]).includes(id)) {
		return 'measured-stub';
	}
	if ((MEASURED_REAL_IDS as readonly string[]).includes(id)) {
		return 'measured-real';
	}
	return 'unknown';
}

/**
 * Prefer a measured-real id. NEVER fall back to a measured stub — silently
 * routing "Auto" onto a stub is how a turn reads as success while answering
 * with nothing.
 */
export function pickCatalogId(ids: readonly string[]): string | undefined {
	const real = ids.find(id => catalogIdKind(id) === 'measured-real');
	if (real) {
		return real;
	}
	return ids.find(id => catalogIdKind(id) === 'unknown');
}

/**
 * What the Auto entry can honestly say.
 *
 * `unresolved` is 120's addition to the overlay's three. The remote credential
 * lands 66s-5m37s after startup (`[119]`, `#1410`); for that whole window an
 * empty catalogue is NOT the same claim as "no models available", and saying so
 * is the difference between "wait" and "broken".
 */
export type AutoRouteLabel = 'unresolved' | 'ready' | 'unavailable-stubs' | 'unavailable-empty';

export interface AutoRouteDecision {
	readonly label: AutoRouteLabel;
	readonly id?: string;
}

/**
 * @param ids catalogue ids, or `undefined` when the catalogue has not resolved
 * yet. `[]` means resolved AND empty — a different, terminal claim.
 */
export function autoRouteLabel(ids: readonly string[] | undefined): AutoRouteLabel {
	if (ids === undefined) {
		return 'unresolved';
	}
	if (ids.length === 0) {
		return 'unavailable-empty';
	}
	return pickCatalogId(ids) ? 'ready' : 'unavailable-stubs';
}

export function autoRouteDecision(ids: readonly string[] | undefined): AutoRouteDecision {
	const label = autoRouteLabel(ids);
	const id = ids ? pickCatalogId(ids) : undefined;
	return id ? { label, id } : { label };
}

/**
 * Operator-facing text for the Auto entry. Never names a host, a URL or a
 * credential — only a state and, when there is one, the model that would serve.
 */
export function honestAutoText(label: AutoRouteLabel, policyId?: string): string {
	switch (label) {
		case 'unresolved':
			return 'Auto (connecting…)';
		case 'unavailable-stubs':
			return 'Auto (unavailable — stub catalog)';
		case 'unavailable-empty':
			return 'Auto (unavailable — empty catalog)';
		case 'ready':
			return policyId ? `Auto (${policyId})` : 'Auto';
	}
}
