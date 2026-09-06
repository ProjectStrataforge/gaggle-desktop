/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AuthenticationError,
	CancellationError,
	NetworkError,
	NotFoundError,
	PermissionError,
	RateLimitError,
	TimeoutError,
	UpstreamError,
	type ChatCompletionRequest,
	type Client,
	type Message,
} from '@projectstrataforge/sovereign-router-sdk';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/protocol/common/actions.js';
import { ErrorInfo, UsageInfo } from '../../common/state/protocol/common/state.js';
import { ResponsePartKind, type ResponsePart } from '../../common/state/protocol/channels-chat/state.js';
import { attributionFrom, attributionLogLine, attributionPart, usageFrom } from './gaggleAttribution.js';
import { gaggleCopy } from './gaggleCopy.js';
import type { GaggleAttribution, GaggleHopKind, GaggleUsage } from './gaggleTypes.js';

// Gaggle 114 — one turn through the SMR SDK, surfaced as the host's chat actions.
// The host has already dispatched ChatTurnStarted and handed us its turnId; we
// create the markdown part, append one ChatDelta per SDK chunk, add the
// attribution part and usage, then ChatTurnComplete. Failure → ChatError with copy
// that names what to check. Abort → the stream is closed within one chunk and
// nothing else is emitted: the host already owns the cancelled state.

export interface GaggleTurnInput {
	readonly chat: URI;
	readonly turnId: string;
	readonly hop: GaggleHopKind;
	readonly model: string;
	readonly messages: readonly Message[];
	/** Only `stream` is used, so tests can hand in a scripted fake. */
	readonly client: Pick<Client, 'stream'>;
	readonly signal: AbortSignal;
	/** Parts to append before the reply (e.g. the once-per-session memory-off notice). */
	readonly leadingParts?: readonly ResponsePart[];
	/** Parts to append after the reply (e.g. citations). */
	readonly trailingParts?: readonly ResponsePart[];
}

export interface GaggleTurnOutcome {
	readonly state: 'complete' | 'cancelled' | 'error';
	readonly replyMarkdown: string;
	readonly attribution?: GaggleAttribution;
	readonly usage?: GaggleUsage;
	readonly error?: ErrorInfo;
	readonly durationMs: number;
}

export type GaggleSignalEmitter = (signal: AgentSignal) => void;

/** Map an SDK failure to honest, actionable copy. Never includes a request or response body. */
export function mapTurnError(err: unknown, hop: GaggleHopKind, model: string): ErrorInfo {
	if (err instanceof AuthenticationError || err instanceof PermissionError) {
		return { errorType: 'noCredential', message: gaggleCopy.noCredential(hop) };
	}
	if (err instanceof NotFoundError) {
		return { errorType: 'modelUnknown', message: gaggleCopy.modelUnknown(model) };
	}
	if (err instanceof NetworkError || err instanceof TimeoutError) {
		return { errorType: 'hopUnreachable', message: gaggleCopy.hopUnreachable(hop) };
	}
	if (err instanceof RateLimitError) {
		return { errorType: 'rateLimited', message: gaggleCopy.turnFailed('rate limited by the hop; wait and retry') };
	}
	if (err instanceof UpstreamError) {
		return { errorType: 'upstream', message: gaggleCopy.turnFailed(firstLine(err.message)) };
	}
	const detail = err instanceof Error ? firstLine(err.message) : String(err);
	return { errorType: 'turnFailed', message: gaggleCopy.turnFailed(detail) };
}

function firstLine(text: string): string {
	return text.split(/\r?\n/)[0]?.trim() || 'unknown error';
}

export function toUsageInfo(usage: GaggleUsage | undefined, model: string): UsageInfo | undefined {
	if (!usage) {
		return undefined;
	}
	return { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, model };
}

export async function runTurn(input: GaggleTurnInput, emit: GaggleSignalEmitter, logService: ILogService): Promise<GaggleTurnOutcome> {
	const { chat, turnId, hop, model, client, signal } = input;
	const startedAt = Date.now();
	const replyPartId = `${turnId}#reply`;
	const action = (a: Parameters<typeof emitAction>[1]) => emitAction(emit, a, chat);

	for (const part of input.leadingParts ?? []) {
		action({ type: ActionType.ChatResponsePart, turnId, part });
	}
	action({ type: ActionType.ChatResponsePart, turnId, part: { kind: ResponsePartKind.Markdown, id: replyPartId, content: '' } });
	action({ type: ActionType.ChatActivityChanged, activity: 'streaming' });

	let reply = '';
	try {
		const request: ChatCompletionRequest = { model, messages: [...input.messages] };
		const stream = client.stream(request, { signal });
		for await (const chunk of stream) {
			if (signal.aborted) {
				break;
			}
			if (chunk.delta) {
				reply += chunk.delta;
				action({ type: ActionType.ChatDelta, turnId, partId: replyPartId, content: chunk.delta });
			}
		}
		if (signal.aborted) {
			action({ type: ActionType.ChatActivityChanged, activity: undefined });
			return { state: 'cancelled', replyMarkdown: reply, durationMs: Date.now() - startedAt };
		}
		const attribution = attributionFrom(hop, model, stream.routing, Date.now() - startedAt);
		const usage = usageFrom(stream.usage);
		action({ type: ActionType.ChatResponsePart, turnId, part: attributionPart(`${turnId}#attribution`, attribution) });
		for (const part of input.trailingParts ?? []) {
			action({ type: ActionType.ChatResponsePart, turnId, part });
		}
		const usageInfo = toUsageInfo(usage, attribution.servedModel);
		if (usageInfo) {
			action({ type: ActionType.ChatUsage, turnId, usage: usageInfo });
		}
		const durationMs = Date.now() - startedAt;
		action({ type: ActionType.ChatActivityChanged, activity: undefined });
		action({ type: ActionType.ChatTurnComplete, turnId, duration: durationMs });
		logService.info(attributionLogLine(turnId, attribution, usage));
		return { state: 'complete', replyMarkdown: reply, attribution, usage, durationMs };
	} catch (err) {
		const durationMs = Date.now() - startedAt;
		action({ type: ActionType.ChatActivityChanged, activity: undefined });
		if (signal.aborted || err instanceof CancellationError) {
			return { state: 'cancelled', replyMarkdown: reply, durationMs };
		}
		const error = mapTurnError(err, hop, model);
		logService.warn(`gaggle turn ${turnId}: ${error.errorType} on the ${hop} hop (${durationMs} ms)`);
		action({ type: ActionType.ChatError, turnId, duration: durationMs, error });
		return { state: 'error', replyMarkdown: reply, error, durationMs };
	}
}

type ChatActionOf = Extract<AgentSignal, { kind: 'action' }>['action'];

function emitAction(emit: GaggleSignalEmitter, action: ChatActionOf, chat: URI): void {
	emit({ kind: 'action', resource: chat, action });
}
