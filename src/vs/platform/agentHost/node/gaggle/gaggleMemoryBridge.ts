/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResponsePartKind, type ResponsePart } from '../../common/state/protocol/channels-chat/state.js';
import { gaggleCopy } from './gaggleCopy.js';
import type { GaggleTurnRecord } from './gaggleTypes.js';

// Gaggle 114 — the memory seam. SovereignDB is the only memory spine the
// constitution allows (Principle II); the SovereignDB bridge lands with the
// sovereign-db 1030 TypeScript SDK. Until then the null bridge keeps chat working
// and says so once per session — memory off is a fact, not a silent default.

export interface GaggleCitation {
	readonly id: string;
	readonly title: string;
	readonly snippet: string;
	readonly source?: string;
}

export interface IGaggleMemoryBridge {
	/** True when a SovereignDB is assigned and the bridge can read/write it. */
	readonly enabled: boolean;
	/** Context for the next prompt; empty when memory is off or retrieval fails. */
	retrieve(prompt: string, k: number): Promise<readonly GaggleCitation[]>;
	/** Remember a completed turn. Must never throw into the turn; log and move on. */
	capture(turn: GaggleTurnRecord): Promise<void>;
}

export const SOVDB_BASE_URL_KEY = 'SOVDB_BASE_URL';
export const SOVDB_CHAT_MEMORY_ARRAY_KEY = 'SOVDB_CHAT_MEMORY_ARRAY';

export function isSovereignDbAssigned(env: Readonly<Record<string, string | undefined>>): boolean {
	return typeof env[SOVDB_BASE_URL_KEY] === 'string' && env[SOVDB_BASE_URL_KEY]!.trim().length > 0;
}

export class NullMemoryBridge implements IGaggleMemoryBridge {
	readonly enabled = false;
	async retrieve(): Promise<readonly GaggleCitation[]> {
		return [];
	}
	async capture(): Promise<void> {
		// Nothing is remembered; the session carries the memory-off notice instead.
	}
}

/** The single memory-off notice a session shows on its first turn. */
export function memoryOffNoticePart(): ResponsePart {
	return {
		kind: ResponsePartKind.SystemNotification,
		content: gaggleCopy.memoryOff(),
		_meta: { gaggle: 'memory-off' },
	};
}

/** Citations rendered under a reply as one markdown part. */
export function citationsPart(partId: string, citations: readonly GaggleCitation[]): ResponsePart | undefined {
	if (citations.length === 0) {
		return undefined;
	}
	const lines = citations.map((c, i) => `${i + 1}. **${c.title}** — ${c.snippet}${c.source ? ` (${c.source})` : ''}`);
	return {
		kind: ResponsePartKind.Markdown,
		id: partId,
		content: `\n\n${lines.join('\n')}`,
	};
}
