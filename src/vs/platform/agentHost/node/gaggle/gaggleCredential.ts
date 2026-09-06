/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Credentials, TokenProvider } from '@projectstrataforge/sovereign-router-sdk';
import type { GaggleHopKind } from './gaggleTypes.js';

// Gaggle 114 — the credential the SMR SDK needs for a hop. Both hops take the
// workstation's SMR_API_KEY (tech-stack: "Bearer for remote SMR listModels / chat";
// the Ask chat's remote-secret resolver reads the same env first, then OS
// SecretStorage, which this process cannot see). An Entra-fronted hop is served by
// a token provider the caller injects (Principle IV) — fetched per request, never
// held here. Nothing in this file is ever logged.

export const SMR_API_KEY_KEY = 'SMR_API_KEY';

export type GaggleEnv = Readonly<Record<string, string | undefined>>;

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Resolve the credential for a hop. `tokenProvider`, when given, wins for the
 * remote hop (Entra-fronted assignment); the local Slim always uses the API key.
 */
export function resolveCredential(env: GaggleEnv, hop: GaggleHopKind, tokenProvider?: TokenProvider): Credentials | undefined {
	if (hop === 'remote' && tokenProvider) {
		return { tokenProvider };
	}
	const apiKey = nonempty(env[SMR_API_KEY_KEY]);
	return apiKey ? { apiKey } : undefined;
}

/** True when a credential exists for the hop, without revealing anything about it. */
export function hasCredential(env: GaggleEnv, hop: GaggleHopKind, tokenProvider?: TokenProvider): boolean {
	return resolveCredential(env, hop, tokenProvider) !== undefined;
}
