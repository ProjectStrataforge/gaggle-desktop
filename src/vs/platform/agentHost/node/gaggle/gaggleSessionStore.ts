/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentSession } from '../../common/agentService.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { GAGGLE_PROVIDER_ID, type GaggleSessionRecord, type GaggleTurnRecord } from './gaggleTypes.js';

// Gaggle 114 — sessions live where the host already puts per-session data
// (`<userData>/agentSessionData/<key>/`): one JSON for the session, one
// append-only JSONL for its turns. The prompt text is persisted here and nowhere
// else; nothing in this file writes to the log except metadata.

export const GAGGLE_SESSION_FILE = 'gaggle-session.json';
export const GAGGLE_TURNS_FILE = 'gaggle-turns.jsonl';
export const GAGGLE_TITLE_MAX = 80;

/** First non-empty prompt line, at most {@link GAGGLE_TITLE_MAX} characters — never the whole prompt. */
export function titleFromPrompt(prompt: string): string {
	const line = prompt.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? '';
	return line.length > GAGGLE_TITLE_MAX ? `${line.slice(0, GAGGLE_TITLE_MAX - 1)}…` : line;
}

export interface GaggleSessionListing {
	readonly session: URI;
	readonly record: GaggleSessionRecord;
	readonly folderMissing: boolean;
	readonly createdAt: number;
	readonly modifiedAt: number;
}

export class GaggleSessionStore {
	constructor(
		private readonly _sessionData: ISessionDataService,
		private readonly _logService: ILogService,
	) { }

	private _dir(session: URI): string {
		return this._sessionData.getSessionDataDir(session).fsPath;
	}

	/** The root every session data dir hangs off — the parent of any session's dir. */
	private _root(): string {
		return dirname(this._sessionData.getSessionDataDir(AgentSession.uri(GAGGLE_PROVIDER_ID, 'root-probe'))).fsPath;
	}

	async create(session: URI, record: GaggleSessionRecord): Promise<void> {
		const dir = this._dir(session);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(join(dir, GAGGLE_SESSION_FILE), JSON.stringify(record, null, 2), 'utf8');
	}

	async read(session: URI): Promise<GaggleSessionRecord | undefined> {
		return readSessionFile(join(this._dir(session), GAGGLE_SESSION_FILE));
	}

	async update(session: URI, patch: Partial<GaggleSessionRecord>): Promise<GaggleSessionRecord | undefined> {
		const current = await this.read(session);
		if (!current) {
			return undefined;
		}
		const next: GaggleSessionRecord = { ...current, ...patch };
		await fs.promises.writeFile(join(this._dir(session), GAGGLE_SESSION_FILE), JSON.stringify(next, null, 2), 'utf8');
		return next;
	}

	async appendTurn(session: URI, turn: GaggleTurnRecord): Promise<void> {
		const dir = this._dir(session);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.appendFile(join(dir, GAGGLE_TURNS_FILE), `${JSON.stringify(turn)}\n`, 'utf8');
	}

	/**
	 * Gaggle 123: write the carried transcript in one shot before the session
	 * is announced. `appendTurn` stays append-only; this is the only place a
	 * turns file is created whole.
	 */
	async seedTurns(session: URI, turns: readonly GaggleTurnRecord[]): Promise<void> {
		if (turns.length === 0) {
			return;
		}
		const dir = this._dir(session);
		await fs.promises.mkdir(dir, { recursive: true });
		const body = `${turns.map(turn => JSON.stringify(turn)).join('\n')}\n`;
		await fs.promises.writeFile(join(dir, GAGGLE_TURNS_FILE), body, 'utf8');
	}

	/** Replays the turn log. A corrupt line (typically a torn trailing write) is dropped with one log line, never a crash. */
	async readTurns(session: URI): Promise<GaggleTurnRecord[]> {
		const file = join(this._dir(session), GAGGLE_TURNS_FILE);
		let text: string;
		try {
			text = await fs.promises.readFile(file, 'utf8');
		} catch (err) {
			if (isNotFound(err)) {
				return [];
			}
			throw err;
		}
		const turns: GaggleTurnRecord[] = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) {
				continue;
			}
			try {
				const parsed = JSON.parse(line) as GaggleTurnRecord;
				if (typeof parsed.turnId === 'string') {
					turns.push(parsed);
				}
			} catch {
				this._logService.warn(`gaggle sessions: dropped corrupt turn line ${i + 1} in ${GAGGLE_TURNS_FILE} for ${AgentSession.id(session)}`);
			}
		}
		return turns;
	}

	async list(): Promise<GaggleSessionListing[]> {
		const root = this._root();
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(root, { withFileTypes: true });
		} catch (err) {
			if (isNotFound(err)) {
				return [];
			}
			throw err;
		}
		const out: GaggleSessionListing[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = join(root, entry.name);
			const record = await readSessionFile(join(dir, GAGGLE_SESSION_FILE));
			if (!record) {
				continue;
			}
			const turnsStat = await statOrUndefined(join(dir, GAGGLE_TURNS_FILE));
			const sessionStat = await statOrUndefined(join(dir, GAGGLE_SESSION_FILE));
			const createdAt = Date.parse(record.createdAt) || sessionStat?.mtimeMs || Date.now();
			out.push({
				session: AgentSession.uri(GAGGLE_PROVIDER_ID, record.sessionId),
				record,
				folderMissing: record.folder !== undefined && !(await exists(record.folder)),
				createdAt,
				modifiedAt: turnsStat?.mtimeMs ?? sessionStat?.mtimeMs ?? createdAt,
			});
		}
		out.sort((a, b) => b.modifiedAt - a.modifiedAt);
		return out;
	}

	async remove(session: URI): Promise<void> {
		await fs.promises.rm(this._dir(session), { recursive: true, force: true });
	}
}

async function readSessionFile(file: string): Promise<GaggleSessionRecord | undefined> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as GaggleSessionRecord;
		return typeof parsed.sessionId === 'string' && typeof parsed.createdAt === 'string' ? parsed : undefined;
	} catch (err) {
		if (isNotFound(err)) {
			return undefined;
		}
		// A corrupt session file lists as absent rather than crashing the whole list.
		return undefined;
	}
}

async function statOrUndefined(file: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.stat(file);
	} catch {
		return undefined;
	}
}

async function exists(p: string): Promise<boolean> {
	return (await statOrUndefined(p)) !== undefined;
}

function isNotFound(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
