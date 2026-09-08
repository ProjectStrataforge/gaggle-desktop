/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Gaggle 114 — plain data shapes for the Gaggle agent provider. Dependency-free on
// purpose: the Gaggle overlay's parity tests import these by sibling path.

/** Provider id embedded in every session URI (`AgentSession.uri('gaggle', id)`). */
export const GAGGLE_PROVIDER_ID = 'gaggle';

/** Which class of SMR hop served a request. Never the raw base URL or a key. */
export type GaggleHopKind = 'local' | 'remote';

/** A resolved SMR hop: the bare origin (the SDK/data-plane rule joins `/v1`). */
export interface GaggleHop {
	readonly kind: GaggleHopKind;
	readonly baseUrl: string;
}

/** Persisted per session in `gaggle-session.json`. */
export interface GaggleSessionRecord {
	readonly sessionId: string;
	/** First working directory at creation; may no longer exist. */
	readonly folder?: string;
	readonly createdAt: string;
	modelId?: string;
	/**
	 * 121: which assigned SMR plane this session talks to. Unset follows the
	 * default (local-first). A profile NAME, never a URL and never a credential.
	 */
	hopProfile?: string;
	/** First prompt line, ≤ 80 chars — never the full prompt. */
	title?: string;
}

/** What actually served a turn (`CompletionStream.routing`), for the reply part and the log line. */
export interface GaggleAttribution {
	readonly hop: GaggleHopKind;
	readonly servedModel: string;
	readonly fallbackChain: readonly string[];
	readonly latencyMs?: number;
	readonly requestId?: string;
}

export interface GaggleUsage {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly totalTokens?: number;
}

/** One line of `gaggle-turns.jsonl`. The prompt is persisted locally only — never logged. */
export interface GaggleTurnRecord {
	readonly turnId: string;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly prompt: string;
	readonly replyMarkdown: string;
	readonly attribution?: GaggleAttribution;
	readonly usage?: GaggleUsage;
	readonly state: 'complete' | 'cancelled' | 'error';
	readonly error?: { readonly message: string; readonly code?: string };
}
