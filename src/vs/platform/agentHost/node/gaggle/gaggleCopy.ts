/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

// Gaggle 114 — every user-facing string the Gaggle provider can emit. Each one names
// what to check. None demands a sign-in, names GitHub, or mentions a Copilot path:
// Goose ships no such plane, and a message that points at one is a lie.

export const gaggleCopy = {
	noHopConfigured: (): string => localize(
		'gaggle.noHopConfigured',
		"No model route is assigned. Set SMR_BASE_URL (local Slim) or SMR_REMOTE in your environment, then start a new session. See docs/desktop/fork-bootstrap.md."
	),
	noCredential: (hop: string): string => localize(
		'gaggle.noCredential',
		"The assigned SMR hop ({0}) needs a credential: SMR_API_KEY for the local Slim, SMR_REMOTE_API for the assigned remote. Nothing was sent.",
		hop
	),
	hopUnreachable: (hop: string): string => localize(
		'gaggle.hopUnreachable',
		"Could not reach the SMR hop ({0}). Check the assignment and its health probe (SMR_HEALTHZ_PATH), then try again.",
		hop
	),
	modelUnknown: (modelId: string): string => localize(
		'gaggle.modelUnknown',
		"Model '{0}' is not in the current SMR catalogue. Pick a listed model.",
		modelId
	),
	notSupported: (capability: string): string => localize(
		'gaggle.notSupported',
		"This agent does not support {0}.",
		capability
	),
	memoryOff: (): string => localize(
		'gaggle.memoryOff',
		"Memory is off for this session: no SovereignDB is assigned (SOVDB_BASE_URL). Replies still stream; nothing is remembered."
	),
	turnFailed: (detail: string): string => localize(
		'gaggle.turnFailed',
		"The SMR hop returned an error: {0}",
		detail
	),
	servedBy: (model: string, hop: string): string => localize(
		'gaggle.servedBy',
		"served by {0} via {1}",
		model,
		hop
	),
	fallbacks: (chain: string): string => localize(
		'gaggle.fallbacks',
		"fallbacks: {0}",
		chain
	),
} as const;
