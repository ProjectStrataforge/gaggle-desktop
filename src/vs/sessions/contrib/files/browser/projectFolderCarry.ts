/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { folderKeyFor } from '../../changes/browser/folderTabsModel.js';
import type { Turn } from '../../../../platform/agentHost/common/state/protocol/state.js';

/**
 * Gaggle 123 — decision rules for "continue this conversation in another
 * project". Pure so the overlay and the vendor suite can pin them without
 * driving the workbench. One data path for pill and tab menu.
 */

export const CONTINUE_CONVERSATION_IN_COMMAND_ID = 'workbench.agentSessions.action.continueConversationIn';
export const SHOW_PROJECT_FOLDER_MENU_COMMAND_ID = 'workbench.agentSessions.action.showProjectFolderMenu';

export type ProjectFolderCarryVerdict =
	| 'same-folder'
	| 'foreground'
	| 'carry'
	| 'refuse';

export function carryVerdict(sourceFolder: string | undefined, targetFolder: string | undefined, targetAlreadyHasSession: boolean): ProjectFolderCarryVerdict {
	const source = folderKeyFor(sourceFolder);
	const target = folderKeyFor(targetFolder);
	if (!target) {
		return 'refuse';
	}
	if (source && source === target) {
		return 'same-folder';
	}
	if (targetAlreadyHasSession) {
		return 'foreground';
	}
	return 'carry';
}

/** Stamp the source folder on each turn so GaggleAgent can record `carriedFrom` without a new create-config field. */
export function stampCarriedFrom(turns: readonly Turn[], sourceFolder: string | undefined): Turn[] {
	if (!sourceFolder) {
		return [...turns];
	}
	return turns.map(turn => ({
		...turn,
		message: {
			...turn.message,
			_meta: { ...turn.message._meta, gaggleCarriedFrom: sourceFolder },
		},
	}));
}
