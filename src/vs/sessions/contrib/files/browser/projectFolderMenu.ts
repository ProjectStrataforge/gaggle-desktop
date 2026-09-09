/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { CHAT_DELEGATE_TO_AGENT_HOST_SESSION_COMMAND_ID, IAgentHostDelegationRequest } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { importedTurnsFromChatModel } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/importLocalConversationToAgentSession.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { folderKeyFor } from '../../changes/browser/folderTabsModel.js';
import { ISessionsRecentWorkspacesService } from '../../../services/sessions/browser/sessionsRecentWorkspacesService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { carryVerdict, CONTINUE_CONVERSATION_IN_COMMAND_ID, SHOW_PROJECT_FOLDER_MENU_COMMAND_ID, stampCarriedFrom } from './projectFolderCarry.js';

export { CONTINUE_CONVERSATION_IN_COMMAND_ID, SHOW_PROJECT_FOLDER_MENU_COMMAND_ID };

export interface IProjectFolderMenuAnchor {
	readonly x: number;
	readonly y: number;
}

/** Shared menu for the header pill dropdown and the folder-tab context menu. One data path. */
export function showProjectFolderMenu(accessor: ServicesAccessor, anchor: IProjectFolderMenuAnchor): void {
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagement = accessor.get(ISessionsManagementService);
	const recents = accessor.get(ISessionsRecentWorkspacesService);
	const contextMenuService = accessor.get(IContextMenuService);
	const commandService = accessor.get(ICommandService);
	const fileDialog = accessor.get(IFileDialogService);
	const notification = accessor.get(INotificationService);

	const active = sessionsService.activeSession.get();
	const currentFolder = active?.workspace.get()?.folders.at(0)?.workingDirectory;
	const currentKey = folderKeyFor(currentFolder?.fsPath ?? currentFolder?.toString());

	const actions: IAction[] = [];
	if (currentFolder && active) {
		actions.push(toAction({
			id: 'projectFolder.current',
			label: localize('projectFolder.current', "{0} (current)", active.workspace.get()?.label ?? currentFolder.fsPath),
			checked: true,
			run: async () => { /* already here — FR-002 keeps the pill click for Files */ },
		}));
	}

	for (const recent of recents.getRecentWorkspaces()) {
		const uri = recent.workspace.folders[0]?.workingDirectory ?? recent.workspace.uri;
		const key = folderKeyFor(uri?.fsPath ?? uri?.toString());
		if (!uri || (key && key === currentKey)) {
			continue;
		}
		actions.push(toAction({
			id: `projectFolder.recent.${key}`,
			label: recent.workspace.label,
			run: async () => {
				await switchToFolder(sessionsService, sessionsManagement, notification, uri);
			},
		}));
	}

	if (actions.length) {
		actions.push(new Separator());
	}

	actions.push(toAction({
		id: 'projectFolder.openFolder',
		label: localize('projectFolder.openFolder', "Open Folder…"),
		run: async () => {
			const picked = await fileDialog.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				title: localize('projectFolder.openFolderTitle', "Open Folder"),
			});
			const folderUri = picked?.[0];
			if (folderUri) {
				await switchToFolder(sessionsService, sessionsManagement, notification, folderUri);
			}
		},
	}));

	actions.push(toAction({
		id: CONTINUE_CONVERSATION_IN_COMMAND_ID,
		label: localize('projectFolder.continueIn', "Continue this conversation in…"),
		run: async () => {
			await commandService.executeCommand(CONTINUE_CONVERSATION_IN_COMMAND_ID);
		},
	}));

	contextMenuService.showContextMenu({
		getAnchor: () => anchor,
		getActions: () => actions,
	});
}

async function switchToFolder(
	sessionsService: ISessionsService,
	sessionsManagement: ISessionsManagementService,
	notification: INotificationService,
	folderUri: URI,
): Promise<void> {
	const existing = sessionBoundToFolder(sessionsManagement.getSessions(), folderUri);
	if (existing) {
		await sessionsService.openSession(existing.resource, { preserveFocus: true });
		notification.info(localize('projectFolder.foregrounded', "That folder already has a session. Brought it forward — the conversation was not carried."));
		return;
	}
	await sessionsService.openNewSession({ folderUri });
}

function sessionBoundToFolder(sessions: readonly ISession[], folderUri: URI): ISession | undefined {
	const target = folderKeyFor(folderUri.fsPath);
	if (!target) {
		return undefined;
	}
	return sessions.find(session => {
		const folder = session.workspace.get()?.folders.at(0)?.workingDirectory;
		return folderKeyFor(folder?.fsPath) === target;
	});
}

class ShowProjectFolderMenuAction extends Action2 {
	constructor() {
		super({
			id: SHOW_PROJECT_FOLDER_MENU_COMMAND_ID,
			title: localize2('projectFolder.menu', 'Project folder'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, anchor?: IProjectFolderMenuAnchor): Promise<void> {
		if (!anchor) {
			return;
		}
		showProjectFolderMenu(accessor, anchor);
	}
}
registerAction2(ShowProjectFolderMenuAction);

class ContinueConversationInAction extends Action2 {
	constructor() {
		super({
			id: CONTINUE_CONVERSATION_IN_COMMAND_ID,
			title: localize2('projectFolder.continueIn.title', 'Continue this conversation in…'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const sessionsManagement = accessor.get(ISessionsManagementService);
		const fileDialog = accessor.get(IFileDialogService);
		const notification = accessor.get(INotificationService);
		const chatService = accessor.get(IChatService);
		const commandService = accessor.get(ICommandService);

		const source = sessionsService.activeSession.get();
		if (!source) {
			return;
		}
		const sourceFolder = source.workspace.get()?.folders.at(0)?.workingDirectory;
		const picked = await fileDialog.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('projectFolder.continueInTitle', "Continue this conversation in…"),
		});
		const target = picked?.[0];
		if (!target) {
			return;
		}

		const existing = sessionBoundToFolder(sessionsManagement.getSessions(), target);
		const verdict = carryVerdict(sourceFolder?.fsPath, target.fsPath, !!existing);
		if (verdict === 'same-folder') {
			return;
		}
		if (verdict === 'foreground' && existing) {
			await sessionsService.openSession(existing.resource, { preserveFocus: true });
			notification.info(localize('projectFolder.foregrounded', "That folder already has a session. Brought it forward — the conversation was not carried."));
			return;
		}
		if (verdict === 'refuse') {
			notification.error(localize('projectFolder.refuse', "Could not continue this conversation there: the folder could not be opened."));
			return;
		}

		const turns = turnsFromSession(chatService, source);
		const stamped = stampCarriedFrom(turns, sourceFolder?.fsPath);
		const request: IAgentHostDelegationRequest = {
			type: source.sessionType.startsWith('agent-host-') ? source.sessionType : `agent-host-${source.sessionType}`,
			displayName: source.workspace.get()?.label ?? 'session',
			prompt: stamped[stamped.length - 1]?.message.text || ' ',
			folderUri: target,
			importConversation: stamped.length
				? { turns: stamped, model: source.modelId.get() ? { id: source.modelId.get()! } : undefined }
				: undefined,
		};
		await commandService.executeCommand(CHAT_DELEGATE_TO_AGENT_HOST_SESSION_COMMAND_ID, request);
	}
}
registerAction2(ContinueConversationInAction);

function turnsFromSession(chatService: IChatService, session: IActiveSession) {
	const chat = session.mainChat.get();
	const model = chatService.getSession(chat.resource) ?? chatService.getSession(session.resource);
	return model ? importedTurnsFromChatModel(model) : [];
}
