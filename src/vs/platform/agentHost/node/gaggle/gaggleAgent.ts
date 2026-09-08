/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Client, type Message as SmrMessage, type TokenProvider } from '@projectstrataforge/sovereign-router-sdk';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentHostClientType } from '../../common/agentHostClientInfo.js';
import {
	AgentSession,
	AgentSignal,
	IActiveClient,
	IAgent,
	IAgentChats,
	IAgentCreateChatForkSource,
	IAgentCreateChatOptions,
	IAgentCreateChatResult,
	IAgentCreateSessionConfig,
	IAgentCreateSessionResult,
	IAgentDescriptor,
	IAgentModelInfo,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentSessionMetadata,
} from '../../common/agentService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/channels-root/commands.js';
import {
	ChatInputAnswer,
	ChatInputResponseKind,
	MessageAttachment,
	MessageKind,
	ModelSelection,
	ProtectedResourceMetadata,
	ResponsePartKind,
	SessionStatus,
	ToolCallResult,
	Turn,
	TurnState,
	type AgentSelection,
	type ResponsePart,
} from '../../common/state/protocol/state.js';
import { parseChatUri } from '../../common/state/sessionState.js';
import { attributionPart } from './gaggleAttribution.js';
import { gaggleCopy } from './gaggleCopy.js';
import { resolveCredential, type GaggleEnv } from './gaggleCredential.js';
import { anyHopConfigured, joinUrl, loadHopConfig, remoteSmrResource, resolveHop, type GaggleHopProbes, type GaggleHopResolution, type GaggleResolvedHop } from './gaggleHopPolicy.js';
import { citationsPart, IGaggleMemoryBridge, isSovereignDbAssigned, memoryOffNoticePart, NullMemoryBridge } from './gaggleMemoryBridge.js';
import { sovereignDbResource } from './gaggleSovereignDbMemoryBridge.js';
import { AuthRequiredReason, type AuthRequiredParams } from '../../common/state/protocol/common/notifications.js';
import { GaggleModelCatalog } from './gaggleModelCatalog.js';
import { GaggleSessionStore, titleFromPrompt } from './gaggleSessionStore.js';
import { runTurn, toUsageInfo } from './gaggleTurnRunner.js';
import { GAGGLE_PROVIDER_ID, type GaggleSessionRecord, type GaggleTurnRecord } from './gaggleTypes.js';

// Gaggle 114 — the Gaggle agent provider. Every generative call is the SMR SDK
// (Principle I); memory is SovereignDB through the bridge seam (Principle II);
// sessions persist in the host's per-session data dirs. The host emits
// ChatTurnStarted and hands us the turnId; we stream the rest.

/** The subset of `fetch` the hop probes need — keeps this file free of DOM lib types. */
export type GaggleFetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface GaggleAgentOptions {
	readonly env?: GaggleEnv;
	readonly fetch?: GaggleFetchLike;
	readonly memoryBridge?: IGaggleMemoryBridge;
	/** Entra-fronted remote hops (Principle IV). Not wired by default; the seam exists. */
	readonly remoteTokenProvider?: TokenProvider;
	/** How long a hop decision is trusted before re-probing. */
	readonly hopTtlMs?: number;
}

interface GaggleSessionState {
	readonly session: URI;
	record: GaggleSessionRecord;
	activeTurn?: { readonly turnId: string; readonly controller: AbortController };
	memoryNoticeShown: boolean;
	readonly clients: Map<string, IActiveClient>;
}

const HISTORY_TURNS = 20;
const LOCAL_PROBE_TIMEOUT_MS = 2000;
const REMOTE_PROBE_TIMEOUT_MS = 5000;

function defaultFetch(): GaggleFetchLike {
	const f = (globalThis as unknown as { fetch?: GaggleFetchLike }).fetch;
	if (!f) {
		return async () => ({ ok: false, status: 0 });
	}
	return f;
}

export class GaggleAgent extends Disposable implements IAgent {
	readonly id = GAGGLE_PROVIDER_ID;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _onDidChangeSessionList = this._register(new Emitter<void>());
	readonly onDidChangeSessionList: Event<void> = this._onDidChangeSessionList.event;

	private readonly _onDidRequireAuth = this._register(new Emitter<Omit<AuthRequiredParams, 'channel'>>());
	readonly onDidRequireAuth: Event<Omit<AuthRequiredParams, 'channel'>> = this._onDidRequireAuth.event;

	private readonly _env: GaggleEnv;
	private readonly _fetch: GaggleFetchLike;
	private readonly _memory: IGaggleMemoryBridge;
	/** The signed-in user's SovereignDB bearer, supplied by the client. Memory only. */
	private _sovereignDbToken: string | undefined;
	/**
	 * Gaggle 119 — the data-plane credential for the remote SMR, supplied by the
	 * client from its vault. Memory only, and stored WITH the resource it was
	 * given for: a key minted for one plane must never be presented to another,
	 * which is a credential disclosure rather than a routing mistake.
	 */
	private _smrCredential: { readonly resource: string; readonly token: string } | undefined;
	private _authRequested = false;
	private readonly _remoteTokenProvider: TokenProvider | undefined;
	private readonly _hopTtlMs: number;
	private readonly _sessionStore: GaggleSessionStore;
	private readonly _catalog: GaggleModelCatalog;
	private readonly _sessions = new Map<string, GaggleSessionState>();
	private readonly _clients = new Map<string, Client>();
	private _hop: { readonly resolution: GaggleHopResolution; readonly at: number } | undefined;
	private _hopInFlight: Promise<GaggleHopResolution> | undefined;

	readonly models: IObservable<readonly IAgentModelInfo[]>;
	readonly chats: IAgentChats;

	constructor(
		options: GaggleAgentOptions | undefined,
		@ILogService private readonly _logService: ILogService,
		@ISessionDataService sessionDataService: ISessionDataService,
	) {
		super();
		this._env = options?.env ?? (process.env as GaggleEnv);
		this._fetch = options?.fetch ?? defaultFetch();
		this._memory = options?.memoryBridge ?? new NullMemoryBridge();
		this._remoteTokenProvider = options?.remoteTokenProvider;
		this._hopTtlMs = options?.hopTtlMs ?? 30_000;
		this._sessionStore = new GaggleSessionStore(sessionDataService, _logService);
		this._catalog = this._register(new GaggleModelCatalog(_logService));
		this.models = this._catalog.models;
		this.chats = this._createChats();
		// Warm the hop + catalogue so the picker has models before the first prompt.
		void this.refreshModels();
	}

	// ---- descriptor -------------------------------------------------------------------------

	getDescriptor(): IAgentDescriptor {
		return {
			provider: GAGGLE_PROVIDER_ID,
			displayName: 'Goose',
			description: 'Chat through the Sovereign Model Router; memory in SovereignDB',
			// Streaming chat only. No peer chats, forks, worktrees or tools — saying so is
			// what keeps the window honest about what this agent can do.
			capabilities: {},
		};
	}

	/**
	 * SovereignDB is OAuth-bound: the token that opens it is the signed-in user's,
	 * and it is the client — which holds that identity — that supplies it. The
	 * agent host never mints, stores on disk, or infers a credential; it declares
	 * the resource and waits to be handed a bearer for it (RFC 9728 / RFC 6750,
	 * the same path the vendor provider uses for GitHub).
	 *
	 * The resource is the ASSIGNED SovereignDB base URL, so a user is only ever
	 * asked for a token covering the instance this deployment was pointed at.
	 */
	getProtectedResources(): ProtectedResourceMetadata[] {
		const resources: ProtectedResourceMetadata[] = [];
		const sovereignDb = sovereignDbResource(this._env);
		if (sovereignDb) {
			resources.push(sovereignDb);
		}
		// 119: the assigned remote plane. Without this the agent host has no
		// credential for it and presents the workstation's LOCAL key, which the
		// plane correctly refuses (`invalid_api_key`).
		const smr = remoteSmrResource(this._env);
		if (smr) {
			resources.push(smr);
		}
		return resources;
	}

	/**
	 * Accept a bearer for a resource we declared. SovereignDB is the only one:
	 * the SMR hop's credential is an assignment (`SMR_API_KEY`), not a user
	 * identity. An unknown resource is refused rather than silently accepted.
	 */
	async authenticate(resource: string, token: string): Promise<boolean> {
		const declared = sovereignDbResource(this._env);
		if (declared && resource === declared.resource) {
			const changed = this._sovereignDbToken !== token;
			this._sovereignDbToken = token;
			if (changed) {
				// The bridge reads the token through a provider, so an updated token is
				// picked up on the next call without rebuilding anything.
				this._logService.info('gaggle memory: SovereignDB credential accepted for the signed-in user');
			}
			return true;
		}
		// 119: the remote SMR data plane. Stored with its resource so it can only
		// ever be presented back to the plane it was issued for. The credential
		// itself is never logged — not its value, not a prefix, not its length.
		const smr = remoteSmrResource(this._env);
		if (smr && resource === smr.resource) {
			const changed = this._smrCredential?.token !== token;
			this._smrCredential = { resource: smr.resource, token };
			if (changed) {
				this._clients.clear();
				this._logService.info(`gaggle hop: data-plane credential accepted for ${smr.resource_name}`);
				// The catalogue is fetched ONCE at construction. Measured: the client
				// supplies this credential ~66s after startup, long after that fetch
				// has already failed with `invalid_api_key` — so without re-reading
				// it here the roster stays empty for the life of the process and the
				// credential arrives to no effect. Clearing the clients is not
				// enough: nothing else re-reads the catalogue.
				void this.refreshModels();
			}
			return true;
		}
		// An undeclared resource is refused rather than quietly accepted.
		return false;
	}

	/**
	 * Ask the client for a SovereignDB credential, once, when memory is wanted
	 * and we hold none. The host forwards this as `auth/required`; the client
	 * answers through {@link authenticate}.
	 */
	private _requireSovereignDbAuth(): void {
		const resource = sovereignDbResource(this._env);
		if (!resource || this._sovereignDbToken || this._authRequested) {
			return;
		}
		this._authRequested = true;
		this._onDidRequireAuth.fire({ resource: resource.resource, reason: AuthRequiredReason.Required });
	}

	// ---- hop, credential, client ------------------------------------------------------------

	private _probes(): GaggleHopProbes {
		const get = async (url: string, timeoutMs: number): Promise<{ ok: boolean; status: number } | undefined> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				return await this._fetch(url, { method: 'GET', signal: controller.signal });
			} catch {
				return undefined;
			} finally {
				clearTimeout(timer);
			}
		};
		return {
			local: async url => (await get(url, LOCAL_PROBE_TIMEOUT_MS))?.ok === true,
			remote: async url => {
				const res = await get(url, REMOTE_PROBE_TIMEOUT_MS);
				return res !== undefined && (res.ok || res.status === 401 || res.status === 403);
			},
		};
	}

	private async _resolveHop(force = false): Promise<GaggleHopResolution> {
		if (!force && this._hop && Date.now() - this._hop.at < this._hopTtlMs) {
			return this._hop.resolution;
		}
		if (this._hopInFlight) {
			return this._hopInFlight;
		}
		this._hopInFlight = resolveHop(this._env, this._probes()).then(resolution => {
			this._hop = { resolution, at: Date.now() };
			this._hopInFlight = undefined;
			if (resolution.ok) {
				this._logService.info(`gaggle hop: ${resolution.hop.kind} (${resolution.hop.profile}, probe=${resolution.hop.probe})`);
			} else {
				// Name the URL that was probed, not just the verdict. A MANGLED
				// base or healthz path and a genuinely dead plane both surface as
				// `local_down_cloud_disallowed`, and telling them apart cost four
				// packaged runs on 2026-09-07 (a shell rewrote `/healthz` into a
				// Windows path, so the probe asked a nonsense URL and the log said
				// only "local down"). The URL is configuration, never a credential.
				const config = loadHopConfig(this._env);
				const probed = config.baseUrl && config.healthzPath
					? ` probed=${joinUrl(config.baseUrl, config.healthzPath)}`
					: '';
				this._logService.warn(`gaggle hop: none (${resolution.reason})${probed}`);
			}
			return resolution;
		});
		return this._hopInFlight;
	}

	/**
	 * 119 — the client-supplied data-plane credential, but ONLY for the plane it
	 * was issued for. A hop to any other plane falls through to the assigned
	 * `SMR_API_KEY`, which is correct for local and honestly refused for a remote
	 * plane we hold no credential for.
	 */
	private _smrTokenProviderFor(hop: GaggleResolvedHop): TokenProvider | undefined {
		if (this._remoteTokenProvider) {
			return this._remoteTokenProvider;
		}
		const held = this._smrCredential;
		if (!held || hop.kind !== 'remote' || held.resource !== hop.dataPlaneBaseUrl) {
			return undefined;
		}
		return () => held.token;
	}

	private _clientFor(hop: GaggleResolvedHop): Client | undefined {
		const credential = resolveCredential(this._env, hop.kind, this._smrTokenProviderFor(hop));
		if (!credential) {
			return undefined;
		}
		const key = `${hop.kind}|${hop.dataPlaneBaseUrl}`;
		let client = this._clients.get(key);
		if (!client) {
			client = new Client({ baseUrl: hop.dataPlaneBaseUrl, ...credential });
			this._clients.set(key, client);
		}
		return client;
	}

	async refreshModels(): Promise<void> {
		const resolution = await this._resolveHop(true);
		if (!resolution.ok) {
			await this._catalog.refresh(undefined, undefined);
			return;
		}
		await this._catalog.refresh(this._clientFor(resolution.hop), resolution.hop.kind);
	}

	// ---- sessions ---------------------------------------------------------------------------

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		if (!anyHopConfigured(this._env)) {
			throw new Error(gaggleCopy.noHopConfigured());
		}
		const sessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		const session = AgentSession.uri(GAGGLE_PROVIDER_ID, sessionId);
		const folderUri = config?.workingDirectories?.[0];
		const record: GaggleSessionRecord = {
			sessionId,
			folder: folderUri?.fsPath,
			createdAt: new Date().toISOString(),
			modelId: config?.model?.id,
		};
		await this._sessionStore.create(session, record);
		this._sessions.set(session.toString(), { session, record, memoryNoticeShown: false, clients: new Map() });
		this._onDidChangeSessionList.fire();
		return {
			session,
			project: folderUri ? { uri: folderUri, displayName: basename(folderUri) } : undefined,
			resolvedWorkingDirectory: folderUri,
		};
	}

	private _sessionOf(chatOrSession: URI): URI {
		const parsed = parseChatUri(chatOrSession.toString());
		return parsed ? URI.parse(parsed.session) : chatOrSession;
	}

	private async _state(chatOrSession: URI): Promise<GaggleSessionState> {
		const session = this._sessionOf(chatOrSession);
		const key = session.toString();
		let state = this._sessions.get(key);
		if (!state) {
			const record = await this._sessionStore.read(session);
			if (!record) {
				throw new Error(`gaggle: unknown session ${AgentSession.id(session)}`);
			}
			state = { session, record, memoryNoticeShown: false, clients: new Map() };
			this._sessions.set(key, state);
		}
		return state;
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: params.config ?? {} };
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const listings = await this._sessionStore.list();
		return listings.map(l => this._metadataOf(l.session, l.record, l.createdAt, l.modifiedAt, l.folderMissing));
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const listings = await this._sessionStore.list();
		const found = listings.find(l => l.session.toString() === session.toString());
		return found ? this._metadataOf(found.session, found.record, found.createdAt, found.modifiedAt, found.folderMissing) : undefined;
	}

	private _metadataOf(session: URI, record: GaggleSessionRecord, startTime: number, modifiedTime: number, folderMissing: boolean): IAgentSessionMetadata {
		const active = this._sessions.get(session.toString())?.activeTurn !== undefined;
		const folder = record.folder ? URI.file(record.folder) : undefined;
		return {
			session,
			startTime,
			modifiedTime,
			summary: record.title,
			status: active ? SessionStatus.InProgress : SessionStatus.Idle,
			activity: folderMissing ? 'folder missing' : undefined,
			project: folder ? { uri: folder, displayName: basename(folder) } : undefined,
			workingDirectories: folder ? [folder] : undefined,
		};
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const turns = await this._sessionStore.readTurns(this._sessionOf(session));
		return turns.map(t => this._turnOf(t));
	}

	private _turnOf(t: GaggleTurnRecord): Turn {
		const parts: ResponsePart[] = [{ kind: ResponsePartKind.Markdown, id: `${t.turnId}#reply`, content: t.replyMarkdown }];
		if (t.attribution) {
			parts.push(attributionPart(`${t.turnId}#attribution`, t.attribution));
		}
		const state = t.state === 'complete' ? TurnState.Complete : t.state === 'cancelled' ? TurnState.Cancelled : TurnState.Error;
		return {
			id: t.turnId,
			startedAt: t.startedAt,
			duration: t.durationMs,
			message: { text: t.prompt, origin: { kind: MessageKind.User } },
			responseParts: parts,
			usage: toUsageInfo(t.usage, t.attribution?.servedModel ?? ''),
			state,
			error: t.error ? { errorType: t.error.code ?? 'turnFailed', message: t.error.message } : undefined,
		};
	}

	async disposeSession(session: URI): Promise<void> {
		const key = this._sessionOf(session).toString();
		const state = this._sessions.get(key);
		state?.activeTurn?.controller.abort();
		this._sessions.delete(key);
		await this._sessionStore.remove(this._sessionOf(session));
		this._onDidChangeSessionList.fire();
	}

	// ---- chats ------------------------------------------------------------------------------

	private _createChats(): IAgentChats {
		return {
			createChat: async (chat: URI, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult | void> => {
				const state = await this._state(chat);
				const patch: Partial<GaggleSessionRecord> = {};
				if (options?.title && !state.record.title) {
					patch.title = options.title;
				}
				if (options?.model?.id) {
					patch.modelId = options.model.id;
				}
				if (Object.keys(patch).length > 0) {
					state.record = (await this._sessionStore.update(state.session, patch)) ?? { ...state.record, ...patch };
				}
				return {};
			},
			fork: async (_chat: URI, _source: IAgentCreateChatForkSource): Promise<IAgentCreateChatResult | void> => {
				throw new Error(gaggleCopy.notSupported('forking a conversation'));
			},
			disposeChat: async (_chat: URI): Promise<void> => {
				// Every chat of a session shares its turn log; nothing to tear down per chat.
			},
			sendMessage: (chat, prompt, workingDirectories, attachments, turnId, senderClientId, clientType) =>
				this._sendMessage(chat, prompt, workingDirectories, attachments, turnId, senderClientId, clientType),
			abort: async (chat: URI): Promise<void> => {
				const state = this._sessions.get(this._sessionOf(chat).toString());
				state?.activeTurn?.controller.abort();
			},
			changeModel: async (chat: URI, model: ModelSelection): Promise<void> => {
				const state = await this._state(chat);
				if (this._catalog.snapshot().length > 0 && !this._catalog.has(model.id)) {
					throw new Error(gaggleCopy.modelUnknown(model.id));
				}
				state.record = (await this._sessionStore.update(state.session, { modelId: model.id })) ?? { ...state.record, modelId: model.id };
			},
			changeAgent: async (_chat: URI, _agent: AgentSelection | undefined): Promise<void> => {
				// One agent; there is nothing to switch to.
			},
			getMessages: (chat: URI): Promise<readonly Turn[]> => this.getSessionMessages(chat),
		};
	}

	private async _sendMessage(
		chat: URI,
		prompt: string,
		_workingDirectories: readonly URI[] | undefined,
		_attachments: readonly MessageAttachment[] | undefined,
		turnId?: string,
		_senderClientId?: string,
		_clientType?: AgentHostClientType,
	): Promise<void> {
		const state = await this._state(chat);
		const id = turnId ?? generateUuid();
		if (state.activeTurn) {
			throw new Error(gaggleCopy.turnFailed('a turn is already running in this session'));
		}
		const resolution = await this._resolveHop();
		if (!resolution.ok) {
			throw new Error(resolution.reason === 'unconfigured'
				? gaggleCopy.noHopConfigured()
				: gaggleCopy.hopUnreachable(resolution.reason === 'local_down_cloud_disallowed' ? 'local' : 'remote'));
		}
		const hop = resolution.hop;
		const client = this._clientFor(hop);
		if (!client) {
			throw new Error(gaggleCopy.noCredential(hop.kind));
		}
		if (this._catalog.snapshot().length === 0) {
			await this._catalog.refresh(client, hop.kind);
		}
		const model = state.record.modelId ?? this._catalog.snapshot()[0]?.id;
		if (!model) {
			throw new Error(gaggleCopy.hopUnreachable(hop.kind));
		}
		if (state.record.modelId && this._catalog.snapshot().length > 0 && !this._catalog.has(state.record.modelId)) {
			throw new Error(gaggleCopy.modelUnknown(state.record.modelId));
		}

		const leadingParts: ResponsePart[] = [];
		if (!this._memory.enabled && !state.memoryNoticeShown) {
			// A SovereignDB IS assigned but memory is off: the missing piece is the
			// user's own credential, so ask the client for one rather than leaving
			// the notice as the end of the story. Fires once per agent.
			this._requireSovereignDbAuth();
			leadingParts.push(memoryOffNoticePart());
			state.memoryNoticeShown = true;
		}
		let citations = [] as Awaited<ReturnType<IGaggleMemoryBridge['retrieve']>>;
		if (this._memory.enabled) {
			try {
				citations = await this._memory.retrieve(prompt, 5);
			} catch (err) {
				this._logService.warn(`gaggle memory: retrieval failed, continuing without context: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const trailingParts: ResponsePart[] = [];
		const citationPart = citationsPart(`${id}#citations`, citations);
		if (citationPart) {
			trailingParts.push(citationPart);
		}

		const history = await this._sessionStore.readTurns(state.session);
		const messages = this._messagesFor(history, prompt, citations.map(c => c.snippet));

		const controller = new AbortController();
		state.activeTurn = { turnId: id, controller };
		const startedAt = new Date().toISOString();
		try {
			const outcome = await runTurn(
				{ chat, turnId: id, hop: hop.kind, model, messages, client, signal: controller.signal, leadingParts, trailingParts },
				signal => this._onDidSessionProgress.fire(signal),
				this._logService,
			);
			const turn: GaggleTurnRecord = {
				turnId: id,
				startedAt,
				durationMs: outcome.durationMs,
				prompt,
				replyMarkdown: outcome.replyMarkdown,
				attribution: outcome.attribution,
				usage: outcome.usage,
				state: outcome.state,
				error: outcome.error ? { message: outcome.error.message, code: outcome.error.errorType } : undefined,
			};
			await this._sessionStore.appendTurn(state.session, turn);
			if (!state.record.title) {
				state.record = (await this._sessionStore.update(state.session, { title: titleFromPrompt(prompt) })) ?? state.record;
				this._onDidChangeSessionList.fire();
			}
			if (outcome.state === 'complete' && this._memory.enabled) {
				try {
					await this._memory.capture(turn);
				} catch (err) {
					this._logService.warn(`gaggle memory: capture failed for turn ${id}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} finally {
			state.activeTurn = undefined;
		}
	}

	private _messagesFor(history: readonly GaggleTurnRecord[], prompt: string, context: readonly string[]): SmrMessage[] {
		const messages: SmrMessage[] = [];
		if (context.length > 0) {
			messages.push({ role: 'system', content: `Relevant context from earlier work:\n${context.map(c => `- ${c}`).join('\n')}` });
		}
		for (const turn of history.filter(t => t.state === 'complete').slice(-HISTORY_TURNS)) {
			messages.push({ role: 'user', content: turn.prompt });
			messages.push({ role: 'assistant', content: turn.replyMarkdown });
		}
		messages.push({ role: 'user', content: prompt });
		return messages;
	}

	// ---- capabilities this agent does not have: answered honestly, never crash ---------------

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// No tool calls, so no permission requests can be pending.
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// No input requests are ever raised by this agent.
	}

	getOrCreateActiveClient(session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = this._sessionOf(session).toString();
		const state = this._sessions.get(key);
		const clients = state?.clients ?? new Map<string, IActiveClient>();
		let active = clients.get(client.clientId);
		if (!active) {
			active = { clientId: client.clientId, displayName: client.displayName, tools: [], customizations: [] };
			clients.set(client.clientId, active);
		}
		return active;
	}

	removeActiveClient(session: URI, clientId: string): void {
		this._sessions.get(this._sessionOf(session).toString())?.clients.delete(clientId);
	}

	onClientToolCallComplete(_session: URI, _chat: URI, _toolCallId: string, _result: ToolCallResult): void {
		// This agent never issues tool calls.
	}

	async shutdown(): Promise<void> {
		for (const state of this._sessions.values()) {
			state.activeTurn?.controller.abort();
		}
	}

	override dispose(): void {
		for (const state of this._sessions.values()) {
			state.activeTurn?.controller.abort();
		}
		super.dispose();
	}
}

/** True when SovereignDB memory can be wired for this process (used by the mains to pick the bridge). */
export function gaggleMemoryAssigned(env: GaggleEnv = process.env as GaggleEnv): boolean {
	return isSovereignDbAssigned(env);
}
