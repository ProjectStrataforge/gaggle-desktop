/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Field, FixedSizeList, Float32, Table, Utf8, makeData, makeVector, tableToIPC, vectorFromArray } from 'apache-arrow';
import { Client } from '@projectstrataforge/sovereign-db-sdk';
import type { ILogService } from '../../../log/common/log.js';
import {
	SOVDB_CHAT_MEMORY_ARRAY_KEY,
	isSovereignDbAssigned,
	type GaggleCitation,
	type IGaggleMemoryBridge,
} from './gaggleMemoryBridge.js';
import type { GaggleTurnRecord } from './gaggleTypes.js';

// Gaggle 114 US3 — conversation memory and retrieval through SovereignDB
// (Principle II: SovereignDB is the only memory spine).
//
// Three rules this file exists to keep, all mirrored from Gaggle's own planes
// rather than invented here:
//
//   1. A vector may only come from an ASSIGNED embedder. There is no synthetic
//      fallback and no literal `[0]` — `packages/sovdb-rag/src/embedder.ts` is
//      fail-closed for exactly this reason, and so is this bridge. No embedder
//      means no retrieval, reported, never a fake vector into the estate.
//   2. A payload gate decides what may be written. Only a SovereignDB
//      destination may receive turn memory, and PII bound for an external hop
//      needs a lead-applied approval (`packages/chat-memory`
//      `MemoryPayloadGate` + `requirePiiExternalApproval`). A refused record is
//      NOT written, and the refusal is logged metadata-only.
//   3. Memory never breaks a turn. Every failure path here returns empty or
//      does nothing, logs metadata only, and lets the chat continue.

/** The SovereignDB surface this bridge uses — a `Pick` so tests can hand it a fake. */
export type GaggleMemoryClient = Pick<Client, 'writeFragments' | 'similarity'>;

/**
 * The one seam through which a query vector may enter. Mirrors
 * `sovdb-rag`'s embedder port: it reports failure rather than producing one.
 */
export interface GaggleEmbedPort {
	embed(text: string): Promise<{ readonly ok: true; readonly vector: number[] } | { readonly ok: false; readonly reason: string }>;
}

/** A lead-applied intent, as `packages/chat-memory` models it. */
export interface GagglePiiExternalIntent {
	readonly class: string;
	readonly status: string;
	readonly id: string;
}

export type MemoryGateDecision =
	| { readonly allowed: true; readonly notice: 'payload_allowed'; readonly destinationClass: 'sovereigndb' }
	| { readonly allowed: false; readonly notice: 'payload_denied' | 'pii_external_refused'; readonly destinationClass: string };

/**
 * Destination classification. The registry default is UNSANCTIONED — a
 * destination is `sovereigndb` only when it is the assigned SovereignDB base
 * URL. Mirrors `containment`'s `classifyDestination` contract without importing
 * it: the fork is a separate tree and may not reach into Gaggle's packages.
 */
export function classifyMemoryDestination(destination: string | undefined, assignedBaseUrl: string | undefined): string {
	const target = destination?.trim();
	const assigned = assignedBaseUrl?.trim();
	if (!target || !assigned) {
		return 'unsanctioned';
	}
	return normalizeBase(target) === normalizeBase(assigned) ? 'sovereigndb' : 'unsanctioned';
}

function normalizeBase(url: string): string {
	return url.replace(/\/+$/, '').toLowerCase();
}

/**
 * `requirePiiExternalApproval`, mirrored: PII bound for an external hop needs a
 * lead-applied `pii_external` intent. Anything else is refused.
 */
export function piiExternalApproved(intent: GagglePiiExternalIntent | undefined): boolean {
	return intent?.class === 'pii_external' && intent.status === 'applied';
}

/** The payload gate: what may be written, and why not when it may not. */
export function checkMemoryPayload(input: {
	readonly destination: string | undefined;
	readonly assignedBaseUrl: string | undefined;
	readonly carriesPiiForExternalHop: boolean;
	readonly intent: GagglePiiExternalIntent | undefined;
}): MemoryGateDecision {
	const destinationClass = classifyMemoryDestination(input.destination, input.assignedBaseUrl);
	if (destinationClass !== 'sovereigndb') {
		return { allowed: false, notice: 'payload_denied', destinationClass };
	}
	if (input.carriesPiiForExternalHop && !piiExternalApproved(input.intent)) {
		return { allowed: false, notice: 'pii_external_refused', destinationClass };
	}
	return { allowed: true, notice: 'payload_allowed', destinationClass: 'sovereigndb' };
}

export interface GaggleSovereignDbMemoryBridgeOptions {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly client: GaggleMemoryClient;
	readonly embedder: GaggleEmbedPort;
	readonly logService: ILogService;
	/** The vector attribute on the chat-memory array. */
	readonly attribute?: string;
	/** A lead-applied approval, when one exists for this session. */
	readonly intent?: GagglePiiExternalIntent;
}

const DEFAULT_CHAT_MEMORY_ARRAY = 'gaggle_chat_memory';
const DEFAULT_VECTOR_ATTRIBUTE = 'embedding';
/** Provenance columns the citations are built from. */
const PROVENANCE_COLUMNS = ['session_id', 'title', 'snippet', 'source'] as const;

export class GaggleSovereignDbMemoryBridge implements IGaggleMemoryBridge {
	readonly enabled: boolean;

	private readonly array: string;
	private readonly attribute: string;
	private readonly baseUrl: string | undefined;

	constructor(private readonly options: GaggleSovereignDbMemoryBridgeOptions) {
		const env = options.env;
		this.enabled = isSovereignDbAssigned(env);
		this.baseUrl = env['SOVDB_BASE_URL'];
		this.array = env[SOVDB_CHAT_MEMORY_ARRAY_KEY]?.trim() || DEFAULT_CHAT_MEMORY_ARRAY;
		this.attribute = options.attribute ?? DEFAULT_VECTOR_ATTRIBUTE;
	}

	/**
	 * Context for the next prompt. Empty on every failure — an unreachable
	 * SovereignDB, a refused read, or no assigned embedder — and the reason is
	 * logged as metadata, never as prompt text.
	 */
	async retrieve(prompt: string, k: number): Promise<readonly GaggleCitation[]> {
		if (!this.enabled) {
			return [];
		}
		const embedded = await this.embedQuietly(prompt);
		if (!embedded) {
			return [];
		}
		try {
			const result = await this.options.client.similarity(this.array, {
				attribute: this.attribute,
				queryVector: embedded,
				k,
				provenanceColumns: [...PROVENANCE_COLUMNS],
			});
			return result.rows<Record<string, unknown>>().map((row, index) => this.toCitation(row, index));
		} catch (error) {
			// Retrieval is best-effort: a turn without memory is still a turn.
			this.options.logService.warn(`gaggle memory: retrieve failed on ${this.array} (${describe(error)})`);
			return [];
		}
	}

	/**
	 * Remember a completed turn. Gated first; a refused record is not written and
	 * the refusal is logged metadata-only. Never throws into the turn.
	 */
	async capture(turn: GaggleTurnRecord): Promise<void> {
		if (!this.enabled) {
			return;
		}
		const decision = checkMemoryPayload({
			destination: this.baseUrl,
			assignedBaseUrl: this.baseUrl,
			// A turn served by a remote hop has already left the box; persisting it
			// makes that exposure durable, so it needs the lead-applied approval.
			carriesPiiForExternalHop: turn.attribution?.hop === 'remote',
			intent: this.options.intent,
		});
		if (!decision.allowed) {
			// Metadata only: the turn id and why. Never the prompt or the reply.
			this.options.logService.info(
				`gaggle memory: capture refused for turn ${turn.turnId} (${decision.notice}, destination=${decision.destinationClass})`,
			);
			return;
		}
		const embedded = await this.embedQuietly(`${turn.prompt}\n\n${turn.replyMarkdown}`);
		if (!embedded) {
			return;
		}
		try {
			await this.options.client.writeFragments(this.array, fragmentFromTurn(turn, embedded));
		} catch (error) {
			this.options.logService.warn(`gaggle memory: capture failed on ${this.array} (${describe(error)})`);
		}
	}

	/** An embedding, or nothing — never a synthetic vector (rule 1). */
	private async embedQuietly(text: string): Promise<number[] | undefined> {
		try {
			const outcome = await this.options.embedder.embed(text);
			if (!outcome.ok) {
				this.options.logService.info(`gaggle memory: no embedding (${outcome.reason}) — memory stays off for this turn`);
				return undefined;
			}
			return outcome.vector;
		} catch (error) {
			this.options.logService.warn(`gaggle memory: embedder threw (${describe(error)})`);
			return undefined;
		}
	}

	private toCitation(row: Record<string, unknown>, index: number): GaggleCitation {
		const source = text(row['source']);
		const id = text(row['session_id']) || `memory-${index + 1}`;
		return {
			id,
			title: text(row['title']) || id,
			snippet: text(row['snippet']),
			...(source ? { source } : {}),
		};
	}
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** A class name, never a message: a transport error can carry a URL with a token in it. */
function describe(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/**
 * One turn as an Arrow IPC stream, in the shape a sparse chat-memory array
 * actually accepts. Proven against a live SovereignDB, which is where both of
 * these were learned:
 *
 *   - the array's DIMENSION column must be present (`x`), not just its
 *     attributes — a fragment without it is refused;
 *   - the vector column must be `FixedSizeList<Float32>[width]`. Arrow's
 *     `tableFromArrays` builds a `List` from a nested array, which is a
 *     different type and is refused.
 *
 * The array is created with `x: int32` and the attributes below; see
 * `docs/desktop/fork-bootstrap.md` for the create body.
 */
export function fragmentFromTurn(turn: GaggleTurnRecord, vector: number[]): Uint8Array {
	const startedAtMs = Date.parse(turn.startedAt);
	const table = new Table({
		// A stable coordinate per turn: the same turn re-captured lands on the same
		// cell rather than growing the array with a duplicate.
		x: makeVector(Int32Array.from([coordinateOf(turn.turnId)])),
		embedding: fixedSizeListColumn([Float32Array.from(vector)]),
		session_id: vectorFromArray([turn.turnId], new Utf8()),
		title: vectorFromArray([titleOf(turn)], new Utf8()),
		snippet: vectorFromArray([turn.replyMarkdown], new Utf8()),
		source: vectorFromArray([turn.attribution ? `${turn.attribution.hop}:${turn.attribution.servedModel}` : 'unattributed'], new Utf8()),
		captured_at: makeVector(BigInt64Array.from([BigInt(Number.isNaN(startedAtMs) ? 0 : startedAtMs)])),
	});
	return tableToIPC(table, 'stream');
}

/** A `FixedSizeList<Float32>[width]` column — the only vector shape the engine accepts. */
function fixedSizeListColumn(vectors: readonly Float32Array[]): ReturnType<typeof makeVector> {
	const width = vectors[0]?.length ?? 0;
	const flat = new Float32Array(width * vectors.length);
	vectors.forEach((v, i) => flat.set(v, i * width));
	const child = makeVector(flat);
	const type = new FixedSizeList(width, new Field('item', new Float32(), false));
	return makeVector(makeData({ type, length: vectors.length, nullCount: 0, child: child.data[0] }));
}

/**
 * A stable non-negative int32 coordinate for a turn id (FNV-1a, 31 bits). The
 * array's domain is `0..10_000_000`, so it is taken modulo that.
 */
function coordinateOf(turnId: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < turnId.length; i += 1) {
		hash ^= turnId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return (hash >>> 1) % 10_000_000;
}

/** A short, prompt-derived label. Kept to one line so a row stays scannable. */
function titleOf(turn: GaggleTurnRecord): string {
	const firstLine = turn.prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
	return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

/**
 * The SovereignDB instance this deployment is pointed at, as an OAuth protected
 * resource. Absent when no SovereignDB is assigned — there is nothing to ask a
 * user to authorise, and asking anyway would be a prompt with no answer.
 *
 * The identifier is the assigned base URL, so the client only ever acquires a
 * token covering the instance the user's own access already governs.
 */
export function sovereignDbResource(
	env: Readonly<Record<string, string | undefined>>,
): { resource: string; resource_name: string } | undefined {
	if (!isSovereignDbAssigned(env)) {
		return undefined;
	}
	return {
		resource: normalizeBase(env['SOVDB_BASE_URL']!.trim()),
		resource_name: 'SovereignDB',
	};
}

/**
 * Build a bridge over the real SDK from a caller-supplied token provider — the
 * signed-in user's bearer, read fresh on every request so a refreshed token is
 * picked up and an expired one is never cached here.
 */
export function createSovereignDbMemoryBridge(options: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tokenProvider: () => string | undefined;
	readonly embedder: GaggleEmbedPort;
	readonly logService: ILogService;
}): GaggleSovereignDbMemoryBridge | undefined {
	const resource = sovereignDbResource(options.env);
	if (!resource) {
		return undefined;
	}
	const client = new Client({
		baseUrl: resource.resource,
		// Per request, never stored: the SDK asks each time it opens a call.
		tokenProvider: () => {
			const token = options.tokenProvider();
			if (!token) {
				// The SDK turns this into a typed authentication error, which the
				// bridge already degrades to "no memory this turn".
				throw new Error('no SovereignDB credential');
			}
			return token;
		},
	});
	return new GaggleSovereignDbMemoryBridge({
		env: options.env,
		client,
		embedder: options.embedder,
		logService: options.logService,
	});
}
