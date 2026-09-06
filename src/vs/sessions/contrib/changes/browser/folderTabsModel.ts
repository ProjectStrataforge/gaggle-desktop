/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gaggle (StrataForge) 113 — the pure model behind the agents-window folder
 * tab strip. Deliberately free of any vscode import so the overlay repo can
 * unit-test it by path; the widget owns DOM and services.
 */

/** One open session as the strip sees it. */
export interface IFolderTabSessionInput {
	/** Stable session key (the session resource as a string). */
	readonly sessionKey: string;
	/** Folder key — see {@link folderKeyFor}; `undefined` while unresolved. */
	readonly folderKey: string | undefined;
	/** Display label for the folder (basename or the workspace label). */
	readonly folderLabel: string;
	/** Recency; the highest value represents its folder. */
	readonly order: number;
}

export interface IFolderTab {
	readonly folderKey: string;
	readonly label: string;
	readonly active: boolean;
	/** The session a click activates: the active one when it lives here, else the most recent. */
	readonly sessionKey: string;
	readonly sessionCount: number;
}

export const FOLDER_TABS_HIDDEN_STORAGE_KEY = 'sessions.folderTabs.hidden';
const FOLDER_TABS_COLLAPSED_STORAGE_PREFIX = 'sessions.folderTabs.collapsed.';

/**
 * Canonical key for a folder. Case-folded because Windows paths compare
 * case-insensitively and the same folder must never become two tabs; the
 * trailing slash is dropped for the same reason.
 */
export function folderKeyFor(workingDirectory: string | undefined): string | undefined {
	const trimmed = workingDirectory?.trim();
	if (!trimmed) {
		return undefined;
	}
	return trimmed.replace(/[\\/]+$/, '').toLowerCase();
}

export function collapsedStorageKey(folderKey: string): string {
	return FOLDER_TABS_COLLAPSED_STORAGE_PREFIX + folderKey;
}

export function parseHiddenFolders(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

export function serializeHiddenFolders(keys: readonly string[]): string {
	return JSON.stringify(Array.from(new Set(keys)));
}

/** Activating a session of a hidden folder brings its tab back (close is view-level). */
export function hiddenAfterActivation(hidden: readonly string[], activeFolderKey: string | undefined): string[] {
	if (!activeFolderKey) {
		return [...hidden];
	}
	return hidden.filter(key => key !== activeFolderKey);
}

/**
 * One tab per distinct resolved folder, in first-seen order of the session
 * list (stable), hidden folders omitted. Sessions whose folder is not yet
 * resolved contribute no tab — never an invented path.
 */
export function computeFolderTabs(
	sessions: readonly IFolderTabSessionInput[],
	activeSessionKey: string | undefined,
	hidden: readonly string[],
): IFolderTab[] {
	const hiddenSet = new Set(hidden);
	const byFolder = new Map<string, { label: string; active: boolean; representative: IFolderTabSessionInput; count: number }>();
	for (const session of sessions) {
		if (!session.folderKey || hiddenSet.has(session.folderKey)) {
			continue;
		}
		const isActive = session.sessionKey === activeSessionKey;
		const existing = byFolder.get(session.folderKey);
		if (!existing) {
			byFolder.set(session.folderKey, { label: session.folderLabel, active: isActive, representative: session, count: 1 });
			continue;
		}
		existing.count++;
		if (isActive) {
			existing.active = true;
			existing.representative = session;
		} else if (!existing.active && session.order > existing.representative.order) {
			existing.representative = session;
		}
	}
	return Array.from(byFolder, ([folderKey, entry]) => ({
		folderKey,
		label: entry.label,
		active: entry.active,
		sessionKey: entry.representative.sessionKey,
		sessionCount: entry.count,
	}));
}

/** The folder key of the active session, when it is resolved. */
export function activeFolderKey(sessions: readonly IFolderTabSessionInput[], activeSessionKey: string | undefined): string | undefined {
	return sessions.find(session => session.sessionKey === activeSessionKey)?.folderKey;
}

/**
 * After closing a tab: the next tab to activate (the one after it, else the
 * one before), or `undefined` when nothing remains visible.
 */
export function nextTabAfterClose(tabs: readonly IFolderTab[], closedFolderKey: string): IFolderTab | undefined {
	const index = tabs.findIndex(tab => tab.folderKey === closedFolderKey);
	if (index < 0) {
		return undefined;
	}
	const remaining = tabs.filter(tab => tab.folderKey !== closedFolderKey);
	if (remaining.length === 0) {
		return undefined;
	}
	return remaining[Math.min(index, remaining.length - 1)];
}
