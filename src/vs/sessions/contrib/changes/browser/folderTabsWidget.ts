/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/folderTabsWidget.css';
import * as dom from '../../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../../base/browser/touch.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignal } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { NEW_SESSION_ACTION_ID } from '../../chat/common/constants.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import {
	activeFolderKey,
	collapsedStorageKey,
	computeFolderTabs,
	FOLDER_TABS_HIDDEN_STORAGE_KEY,
	folderKeyFor,
	hiddenAfterActivation,
	IFolderTab,
	IFolderTabSessionInput,
	nextTabAfterClose,
	parseHiddenFolders,
	serializeHiddenFolders,
} from './folderTabsModel.js';

const $ = dom.$;

/**
 * Gaggle (StrataForge) 113 — the folder tab strip above the Changes and
 * Files areas of the agents window.
 *
 * One tab per distinct open-session folder; clicking a tab activates that
 * folder's session (the area then re-binds through the existing
 * active-session plumbing — no second data path). The active tab carries the
 * open/close chevron (collapse persists per folder, profile scope); every tab
 * carries a view-level close (never ends a session — the tab returns when a
 * session of that folder becomes active); "+" runs the vendor New Session
 * command, the sanctioned way to open a folder.
 */
export class FolderTabsWidget extends Disposable {

	/** Fixed strip height so hosts can lay out before the first paint. */
	static readonly HEIGHT = 30;

	private readonly _domNode: HTMLElement;
	private readonly _tabsDisposables = this._register(new DisposableStore());
	private readonly _sessionsChanged = observableSignal(this);
	private readonly _sessionsByKey = new Map<string, ISession>();
	private _tabs: IFolderTab[] = [];
	private _activeFolderKey: string | undefined;

	private readonly _onDidChangeActiveCollapsed = this._register(new Emitter<boolean>());
	/** Fires with the collapsed state of the ACTIVE folder whenever it may have changed. */
	readonly onDidChangeActiveCollapsed: Event<boolean> = this._onDidChangeActiveCollapsed.event;

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility: Event<boolean> = this._onDidChangeVisibility.event;

	constructor(
		container: HTMLElement,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this._domNode = dom.append(container, $('.folder-tabs-widget'));
		this._domNode.setAttribute('role', 'tablist');
		this._domNode.setAttribute('aria-label', localize('folderTabs.label', "Open folders"));
		this._domNode.style.display = 'none';

		this._register(this._sessionsManagementService.onDidChangeSessions(() => this._sessionsChanged.trigger(undefined)));
		this._register(autorun(reader => {
			this._sessionsChanged.read(reader);
			const active = this._sessionsService.activeSession.read(reader);
			const inputs: IFolderTabSessionInput[] = [];
			this._sessionsByKey.clear();
			for (const session of this._sessionsManagementService.getSessions()) {
				const workspace = session.workspace.read(reader);
				const folder = workspace?.folders[0];
				const key = session.resource.toString();
				this._sessionsByKey.set(key, session);
				inputs.push({
					sessionKey: key,
					folderKey: folderKeyFor(folder?.workingDirectory.toString() ?? (workspace ? workspace.uri.toString() : undefined)),
					folderLabel: folder?.name || workspace?.label || '',
					order: session.createdAt.getTime(),
				});
			}
			this._recompute(inputs, active?.resource.toString());
		}));
	}

	/** Whether the strip is showing (at least one open session with a resolved folder, hidden or not). */
	get visible(): boolean {
		return this._domNode.style.display !== 'none';
	}

	/** Height the strip currently occupies in the host's layout. */
	get height(): number {
		return this.visible ? FolderTabsWidget.HEIGHT : 0;
	}

	/** Whether the ACTIVE folder is collapsed (host hides its body below the strip). */
	get activeCollapsed(): boolean {
		return this._activeFolderKey ? this._isCollapsed(this._activeFolderKey) : false;
	}

	private _recompute(inputs: IFolderTabSessionInput[], activeSessionKey: string | undefined): void {
		const wasVisible = this.visible;
		const wasCollapsed = this.activeCollapsed;

		// Activation brings a closed folder's tab back (close is view-level).
		this._activeFolderKey = activeFolderKey(inputs, activeSessionKey);
		const hidden = hiddenAfterActivation(this._readHidden(), this._activeFolderKey);
		if (hidden.length !== this._readHidden().length) {
			this._writeHidden(hidden);
		}

		this._tabs = computeFolderTabs(inputs, activeSessionKey, hidden);
		const anyResolvedFolder = inputs.some(input => input.folderKey !== undefined);
		this._domNode.style.display = anyResolvedFolder ? '' : 'none';
		this._render(hidden.length > 0);

		if (wasVisible !== this.visible) {
			this._onDidChangeVisibility.fire(this.visible);
		}
		if (wasCollapsed !== this.activeCollapsed || wasVisible !== this.visible) {
			this._onDidChangeActiveCollapsed.fire(this.activeCollapsed);
		}
	}

	private _render(hasHiddenFolders: boolean): void {
		this._tabsDisposables.clear();
		dom.clearNode(this._domNode);

		if (this._tabs.length === 0) {
			const empty = dom.append(this._domNode, $('.folder-tabs-empty'));
			empty.textContent = hasHiddenFolders
				? localize('folderTabs.allClosed', "No folders open — activate a session to bring one back")
				: localize('folderTabs.none', "No folders open");
		}

		for (const tab of this._tabs) {
			this._renderTab(tab);
		}

		const add = dom.append(this._domNode, $('.folder-tabs-add'));
		add.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		add.setAttribute('role', 'button');
		add.setAttribute('aria-label', localize('folderTabs.add', "New Session (open a folder)"));
		add.tabIndex = 0;
		this._tabsDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), add, localize('folderTabs.addHover', "New Session — pick a folder to open")));
		this._onActivate(add, () => this._commandService.executeCommand(NEW_SESSION_ACTION_ID));
	}

	private _renderTab(tab: IFolderTab): void {
		const node = dom.append(this._domNode, $('.folder-tab'));
		node.classList.toggle('active', tab.active);
		node.classList.toggle('collapsed', this._isCollapsed(tab.folderKey));
		node.setAttribute('role', 'tab');
		node.setAttribute('aria-selected', String(tab.active));
		node.setAttribute('data-folder-tab', tab.folderKey);
		node.tabIndex = 0;

		const label = dom.append(node, $('.folder-tab-label'));
		label.textContent = tab.label;
		if (tab.sessionCount > 1) {
			const count = dom.append(node, $('.folder-tab-count'));
			count.textContent = String(tab.sessionCount);
		}
		this._tabsDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), label,
			tab.sessionCount > 1
				? localize('folderTabs.tabHoverMany', "{0} — {1} sessions. Click to switch to this folder.", tab.label, tab.sessionCount)
				: localize('folderTabs.tabHover', "{0} — click to switch to this folder.", tab.label)));
		this._onActivate(node, () => this._activateTab(tab));

		if (tab.active) {
			const chevron = dom.append(node, $('.group-chevron'));
			chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			chevron.setAttribute('role', 'button');
			chevron.setAttribute('aria-label', this._isCollapsed(tab.folderKey)
				? localize('folderTabs.expand', "Open {0}", tab.label)
				: localize('folderTabs.collapse', "Close {0}", tab.label));
			chevron.tabIndex = 0;
			this._onActivate(chevron, () => this._toggleCollapsed(tab.folderKey), true);
		}

		const close = dom.append(node, $('.folder-tab-close'));
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		close.setAttribute('role', 'button');
		close.setAttribute('aria-label', localize('folderTabs.closeOut', "Close out {0} (sessions keep running)", tab.label));
		close.tabIndex = 0;
		this._tabsDisposables.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), close, localize('folderTabs.closeHover', "Close out this folder. Its sessions keep running; activating one brings the tab back.")));
		this._onActivate(close, () => this._closeTab(tab), true);
	}

	/** Click / tap / Enter / Space on an affordance; `stop` keeps nested controls from bubbling to the tab. */
	private _onActivate(target: HTMLElement, handler: () => void, stop = false): void {
		this._tabsDisposables.add(Gesture.addTarget(target));
		for (const eventType of [dom.EventType.CLICK, TouchEventType.Tap]) {
			this._tabsDisposables.add(dom.addDisposableListener(target, eventType, (e: globalThis.Event) => {
				if (stop) {
					e.stopPropagation();
				}
				handler();
			}));
		}
		this._tabsDisposables.add(dom.addDisposableListener(target, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === target) {
				e.preventDefault();
				if (stop) {
					e.stopPropagation();
				}
				handler();
			}
		}));
	}

	private _activateTab(tab: IFolderTab): void {
		if (tab.active) {
			return;
		}
		const session = this._sessionsByKey.get(tab.sessionKey);
		if (session) {
			void this._sessionsService.openSession(session.resource, { preserveFocus: true });
		}
	}

	private _closeTab(tab: IFolderTab): void {
		const next = tab.active ? nextTabAfterClose(this._tabs, tab.folderKey) : undefined;
		this._writeHidden([...this._readHidden(), tab.folderKey]);
		this._sessionsChanged.trigger(undefined);
		if (next) {
			this._activateTab(next);
		}
	}

	private _toggleCollapsed(folderKey: string): void {
		const collapsed = !this._isCollapsed(folderKey);
		if (collapsed) {
			this._storageService.store(collapsedStorageKey(folderKey), true, StorageScope.PROFILE, StorageTarget.USER);
		} else {
			this._storageService.remove(collapsedStorageKey(folderKey), StorageScope.PROFILE);
		}
		this._sessionsChanged.trigger(undefined);
		this._onDidChangeActiveCollapsed.fire(this.activeCollapsed);
	}

	private _isCollapsed(folderKey: string): boolean {
		return this._storageService.getBoolean(collapsedStorageKey(folderKey), StorageScope.PROFILE, false);
	}

	private _readHidden(): string[] {
		return parseHiddenFolders(this._storageService.get(FOLDER_TABS_HIDDEN_STORAGE_KEY, StorageScope.PROFILE));
	}

	private _writeHidden(keys: readonly string[]): void {
		if (keys.length === 0) {
			this._storageService.remove(FOLDER_TABS_HIDDEN_STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this._storageService.store(FOLDER_TABS_HIDDEN_STORAGE_KEY, serializeHiddenFolders(keys), StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}
