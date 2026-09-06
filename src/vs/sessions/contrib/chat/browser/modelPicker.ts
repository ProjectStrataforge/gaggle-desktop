/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, observableValue } from '../../../../base/common/observable.js';
import { localize2 } from '../../../../nls.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IChatInputPickerOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { IModelPickerDelegate, ModelPickerActionItem } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerActionItem.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionUsesCombinedConfigPickerContext } from '../../../common/contextkeys.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { ISessionModelSelectionModel } from './sessionModelSelectionModel.js';
import { INewChatModelPickerService } from './newChatModelPicker.js';
import { reportNewChatPickerClosed } from './newChatPickerTelemetry.js';
import { markOnboardingTarget } from '../../../../workbench/contrib/onboarding/browser/spotlight/onboardingTarget.js';

/**
 * Gaggle (StrataForge): the SMR model plane surfaced in the sessions picker.
 *
 * The sessions picker is provider-scoped — it lists the ACTIVE agent-host
 * agent's models (`ISessionsProvider.getModelsSnapshot`) and hides itself when
 * that list is empty. Goose's model plane is the SMR language-model provider
 * (`gaggle-smr`, registered by the gaggle-chat extension), which no agent-host
 * agent ever lists. So the picker additionally offers every user-selectable
 * `gaggle-smr` model; picking one is an SMR ROUTING decision (the 112 routing
 * control's `agents-pin` / `agents-auto` verbs, dispatched through
 * {@link GAGGLE_SMR_SELECT_COMMAND}), never a provider `setModel`. The pick is
 * remembered per profile so a reload keeps the label honest.
 */
const GAGGLE_SMR_VENDOR = 'gaggle-smr';
const GAGGLE_SMR_SELECT_COMMAND = 'gaggle.smr.selectAgentsModel';
const GAGGLE_SMR_SELECTED_STORAGE_KEY = 'sessions.modelPicker.gaggle-smr.selectedModelIdentifier';

/**
 * The sessions-core model picker. Unlike the previous per-provider pickers,
 * this single widget reads the model list from the active session's provider
 * via {@link ISessionsProvider.getModelsSnapshot}, remembers explicit model choices per
 * shared or targeted model pool, and applies the selection through the existing
 * {@link ISessionsProvider.setModel} API. It reuses the shared workbench
 * {@link ModelPickerActionItem} so the dropdown looks and behaves like the
 * other chat model pickers.
 */
export class ModelPicker extends Disposable {

	private readonly _delegate: IModelPickerDelegate;
	private readonly _modelPicker: ModelPickerActionItem;
	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;
	private readonly _gaggleSmrSelected = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>(this, undefined);

	constructor(
		compact: IObservable<boolean>,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@INewChatModelPickerService private readonly _newChatModelPickerService: INewChatModelPickerService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IChatEntitlementService private readonly _chatEntitlementService: IChatEntitlementService,
		@ISessionContext private readonly _sessionContext: ISessionContext,
		@ISessionModelSelectionModel private readonly _selectionModel: ISessionModelSelectionModel,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ICommandService private readonly _commandService: ICommandService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		const currentModel = derived(this, reader => this._gaggleSmrSelected.read(reader) ?? this._selectionModel.state.read(reader).currentModel);

		this._delegate = {
			currentModel,
			setModel: model => {
				const previousModel = currentModel.get();
				if (model.metadata.vendor === GAGGLE_SMR_VENDOR) {
					this._selectGaggleSmrModel(model, previousModel);
					return;
				}
				this._clearGaggleSmrSelection();
				if (this._selectionModel.selectModel(model.identifier)) {
					reportNewChatPickerClosed(this._telemetryService, {
						id: 'NewChatModelPicker',
						optionIdBefore: previousModel?.identifier,
						optionIdAfter: model.identifier,
						optionLabelBefore: previousModel?.metadata.name,
						optionLabelAfter: model.metadata.name,
						isPII: false,
					});
				}
			},
			getModels: () => [...this._selectionModel.state.get().models, ...this._gaggleSmrModels()],
			getPresentationOptions: () => {
				const state = this._selectionModel.state.get();
				return {
					...state.options,
					// With no provider model the provider's synthetic Auto would sit
					// beside SMR's own "auto" route entry; SMR's is the honest one.
					showAutoModel: state.models.length > 0 ? state.options.showAutoModel : false,
					showModelIcon: true,
				};
			},
			isCacheWarm: () => {
				const session = this._sessionContext.session.get();
				// The session's prompt cache is warm once its first request has
				// been sent (status leaves Untitled), matching the main-window
				// picker which warms as soon as the first request is added.
				return session ? session.status.get() !== SessionStatus.Untitled : false;
			},
		};

		const pickerOptions: IChatInputPickerOptions = {
			compact,
		};
		const action = { id: 'sessions.modelPicker', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } };
		this._modelPicker = this._register(instantiationService.createInstance(ModelPickerActionItem, action, this._delegate, pickerOptions));
		this._register(this._newChatModelPickerService.registerModelPicker({
			open: () => this._modelPicker.openModelPicker(),
			switchToModel: modelIdentifier => this.switchToModel(modelIdentifier),
		}));

		this._register(autorun(reader => {
			this._selectionModel.state.read(reader);
			this._updatePickerState();
		}));

		// SMR models register asynchronously (the extension resolves its catalog
		// after activation); recompute visibility and restore the remembered pick
		// whenever the language-model registry changes.
		this._restoreGaggleSmrSelection();
		this._register(this._languageModelsService.onDidChangeLanguageModels(() => {
			this._restoreGaggleSmrSelection();
			this._updatePickerState();
		}));

		// Re-evaluate when workspace trust changes (or finishes initializing): an
		// untrusted workspace disables the model providers, and the shared widget
		// then renders its Restricted Mode state. Visibility is recomputed so the
		// picker stays visible to surface the "Models" placeholder + the Trust
		// action instead of hiding as an empty picker.
		this._register(this._workspaceTrustManagementService.onDidChangeTrust(() => this._updatePickerState()));
		this._workspaceTrustManagementService.workspaceTrustInitialized.then(() => {
			if (!this._store.isDisposed) {
				this._updatePickerState();
			}
		});

		// Re-evaluate when entitlement / sentiment / anonymous access change: when
		// Chat needs sign-in the shared widget renders a Sign In state, so the
		// picker stays visible to surface it (e.g. after the user signs out/in).
		this._register(this._chatEntitlementService.onDidChangeEntitlement(() => this._updatePickerState()));
		this._register(this._chatEntitlementService.onDidChangeSentiment(() => this._updatePickerState()));
		this._register(this._chatEntitlementService.onDidChangeAnonymous(() => this._updatePickerState()));
	}

	render(container: HTMLElement): void {
		this._renderDisposables.clear();
		this._container = container;
		this._modelPicker.render(container);
		this._renderDisposables.add(markOnboardingTarget(container, 'sessions.newSession.modelPicker', {
			open: () => this._modelPicker.openModelPicker(),
		}));
		this._updatePickerState();
	}

	switchToModel(modelIdentifier: string): boolean {
		const smr = this._gaggleSmrModels().find(model => model.identifier === modelIdentifier);
		if (smr) {
			this._selectGaggleSmrModel(smr, this._delegate.currentModel.get());
			return true;
		}
		this._clearGaggleSmrSelection();
		return this._selectionModel.selectModel(modelIdentifier);
	}

	/** Every user-selectable model the Goose SMR provider currently registers. */
	private _gaggleSmrModels(): ILanguageModelChatMetadataAndIdentifier[] {
		const models: ILanguageModelChatMetadataAndIdentifier[] = [];
		for (const identifier of this._languageModelsService.getLanguageModelIds()) {
			const metadata = this._languageModelsService.lookupLanguageModel(identifier);
			if (metadata?.vendor === GAGGLE_SMR_VENDOR && metadata.isUserSelectable !== false) {
				models.push({ identifier, metadata });
			}
		}
		return models;
	}

	private _selectGaggleSmrModel(model: ILanguageModelChatMetadataAndIdentifier, previousModel: ILanguageModelChatMetadataAndIdentifier | undefined): void {
		this._gaggleSmrSelected.set(model, undefined);
		this._storageService.store(GAGGLE_SMR_SELECTED_STORAGE_KEY, model.identifier, StorageScope.PROFILE, StorageTarget.USER);
		// The routing decision lives in the extension (112 routing control);
		// the picker only names the choice. Failures surface there, never here.
		this._commandService.executeCommand(GAGGLE_SMR_SELECT_COMMAND, model.metadata.id).then(undefined, () => { });
		reportNewChatPickerClosed(this._telemetryService, {
			id: 'NewChatModelPicker',
			optionIdBefore: previousModel?.identifier,
			optionIdAfter: model.identifier,
			optionLabelBefore: previousModel?.metadata.name,
			optionLabelAfter: model.metadata.name,
			isPII: false,
		});
	}

	private _clearGaggleSmrSelection(): void {
		if (this._gaggleSmrSelected.get()) {
			this._gaggleSmrSelected.set(undefined, undefined);
		}
		this._storageService.remove(GAGGLE_SMR_SELECTED_STORAGE_KEY, StorageScope.PROFILE);
	}

	/** Re-bind the remembered SMR pick once its model is registered (never before). */
	private _restoreGaggleSmrSelection(): void {
		if (this._gaggleSmrSelected.get()) {
			return;
		}
		const remembered = this._storageService.get(GAGGLE_SMR_SELECTED_STORAGE_KEY, StorageScope.PROFILE);
		if (!remembered) {
			return;
		}
		const model = this._gaggleSmrModels().find(candidate => candidate.identifier === remembered);
		if (model) {
			this._gaggleSmrSelected.set(model, undefined);
		}
	}

	/**
	 * Whether the model picker should be shown for the given session. Visible
	 * when the session has models, when its Auto model is unavailable (so the
	 * widget can render the "No models available" empty state), or when the
	 * workspace is untrusted / Chat still needs sign-in (so the widget can render
	 * its Restricted Mode or Sign In state). Otherwise hidden, matching the
	 * historical behavior for providers that offer no models.
	 */
	private _shouldShowPicker(): boolean {
		const state = this._selectionModel.state.get();
		if (state.models.length > 0 || this._gaggleSmrModels().length > 0) {
			return true;
		}
		if (this._modelPicker.isRestrictedMode() || this._modelPicker.isSetupRequired()) {
			return true;
		}
		return !state.options.showAutoModel;
	}

	private _updatePickerState(): void {
		const visible = this._shouldShowPicker();
		this._modelPicker.setEnabled(visible);
		this._updateVisibility(visible);
	}

	private _updateVisibility(visible: boolean): void {
		if (this._container) {
			this._container.style.display = visible ? '' : 'none';
		}
	}
}

// -- Action --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.modelPicker',
			title: localize2('sessionsModelPicker', "Model"),
			f1: false,
			menu: [{
				id: Menus.NewSessionConfig,
				group: 'navigation',
				order: 1,
				// Hidden on phone when the active provider supplies a combined
				// mode + model picker instead (see MobileChatInputConfigPicker).
				when: ContextKeyExpr.or(IsPhoneLayoutContext.negate(), SessionUsesCombinedConfigPickerContext.negate()),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

// -- Action View Item --

export class ModelPickerActionViewItem extends BaseActionViewItem {
	constructor(private readonly picker: ModelPicker) {
		super(undefined, { id: '', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
	}

	override render(container: HTMLElement): void {
		this.picker.render(container);
	}

	override dispose(): void {
		this.picker.dispose();
		super.dispose();
	}
}
