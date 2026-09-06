/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RoutingInfo, Usage } from '@projectstrataforge/sovereign-router-sdk';
import { ResponsePartKind, type ResponsePart } from '../../common/state/protocol/channels-chat/state.js';
import { gaggleCopy } from './gaggleCopy.js';
import type { GaggleAttribution, GaggleHopKind, GaggleUsage } from './gaggleTypes.js';

// Gaggle 114 — what actually served a turn, in two places: a small markdown part
// under the reply (what the developer sees) and one agenthost.log line (what the
// packaged spec reads). Both are built from routing/usage only; nothing here can
// be handed prompt or reply text, so nothing here can leak it (Principle III).

export function attributionFrom(hop: GaggleHopKind, requestedModel: string, routing: RoutingInfo | undefined, measuredLatencyMs?: number): GaggleAttribution {
	return {
		hop,
		servedModel: routing?.servedModel || requestedModel,
		fallbackChain: routing?.fallbackChain ?? [],
		latencyMs: routing?.latencyMs ?? measuredLatencyMs,
		requestId: routing?.requestId,
	};
}

export function usageFrom(usage: Usage | undefined): GaggleUsage | undefined {
	if (!usage) {
		return undefined;
	}
	return {
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		totalTokens: usage.totalTokens,
	};
}

/** The reply-trailing part: `served by <model> via <hop>[; fallbacks: a → b]`. */
export function attributionPart(partId: string, attribution: GaggleAttribution): ResponsePart {
	const fallbacks = attribution.fallbackChain.length > 0
		? `; ${gaggleCopy.fallbacks(attribution.fallbackChain.join(' → '))}`
		: '';
	return {
		kind: ResponsePartKind.Markdown,
		id: partId,
		content: `\n\n_${gaggleCopy.servedBy(attribution.servedModel, attribution.hop)}${fallbacks}_`,
	};
}

/** One agenthost.log line per turn — metadata only, never prompt or reply text. */
export function attributionLogLine(turnId: string, attribution: GaggleAttribution, usage: GaggleUsage | undefined): string {
	const chain = attribution.fallbackChain.length > 0 ? attribution.fallbackChain.join(',') : '-';
	return `gaggle turn ${turnId}: hop=${attribution.hop} model=${attribution.servedModel} fallbacks=${chain} `
		+ `prompt_tokens=${usage?.promptTokens ?? '-'} completion_tokens=${usage?.completionTokens ?? '-'} `
		+ `latency_ms=${attribution.latencyMs ?? '-'}`;
}
