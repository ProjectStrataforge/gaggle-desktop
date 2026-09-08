/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Client, Model } from '@projectstrataforge/sovereign-router-sdk';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentModelInfo } from '../../common/agentService.js';
import { autoRouteDecision, honestAutoText, type AutoRouteDecision, type AutoRouteLabel } from './gaggleCatalogHonesty.js';
import { GAGGLE_PROVIDER_ID, type GaggleHopKind } from './gaggleTypes.js';

// Gaggle 114 — the model list is whatever the SMR catalogue serves for the active
// hop (Principle VI: no vendor pin). Empty only when the catalogue is empty or the
// hop is unreachable; either way one log line says so and nothing throws.
//
// Gaggle 120 — two additions. The catalogue now distinguishes NOT YET RESOLVED
// from RESOLVED AND EMPTY, because the remote credential lands 66s-5m37s after
// startup and for that whole window an empty list read as "no models available"
// (#1410). And it advertises an `auto` entry so the router's own routing profile
// is reachable without expanding "Other Models" — the vendor picker promotes a
// model whose id is exactly `auto`, and SMR advertises `router-default`.

/**
 * The id the vendor model picker treats as its Auto entry
 * (`isAutoLanguageModel`: `metadata.id === 'auto'`).
 */
export const GAGGLE_AUTO_MODEL_ID = 'auto';

export function toAgentModelInfo(model: Model): IAgentModelInfo {
	return {
		provider: GAGGLE_PROVIDER_ID,
		id: model.id,
		name: model.id,
		supportsVision: model.capabilities?.vision === true,
		_meta: {
			origin: model.origin,
			ownedBy: model.ownedBy,
			streaming: model.capabilities?.streaming,
		},
	};
}

/**
 * The synthetic Auto entry. It carries the id it would resolve to in `_meta` so
 * the surface can say what Auto means, and so nothing has to guess later.
 */
function autoModelInfo(decision: AutoRouteDecision): IAgentModelInfo {
	return {
		provider: GAGGLE_PROVIDER_ID,
		id: GAGGLE_AUTO_MODEL_ID,
		name: honestAutoText(decision.label, decision.id),
		supportsVision: false,
		_meta: {
			gaggleAutoLabel: decision.label,
			gaggleAutoResolvesTo: decision.id,
		},
	};
}

export class GaggleModelCatalog extends Disposable {
	/**
	 * `undefined` means the catalogue has not resolved yet; `[]` means resolved
	 * and empty. Two different claims, and conflating them is the defect.
	 */
	private _served: readonly IAgentModelInfo[] | undefined = undefined;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('gaggleModels', []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	constructor(private readonly _logService: ILogService) {
		super();
	}

	snapshot(): readonly IAgentModelInfo[] {
		return this._models.get();
	}

	/** True once a refresh has completed, whatever it found. */
	get resolved(): boolean {
		return this._served !== undefined;
	}

	/** What the Auto entry can honestly claim right now. */
	get autoLabel(): AutoRouteLabel {
		return this._decision().label;
	}

	has(modelId: string): boolean {
		return this._models.get().some(m => m.id === modelId);
	}

	/**
	 * Map a selected id to the model that will actually serve the turn. `auto`
	 * resolves through the measured-real rule; everything else is itself.
	 *
	 * The turn record keeps what this returns, never the word `auto` — that log
	 * line is what made this whole class of problem diagnosable, and routing must
	 * not hide what answered (FR-005).
	 */
	resolveModelId(modelId: string | undefined): string | undefined {
		if (modelId !== undefined && modelId !== GAGGLE_AUTO_MODEL_ID) {
			return modelId;
		}
		// Auto, or nothing chosen: prefer a measured-real id, otherwise keep the
		// pre-120 behaviour of taking whatever the plane served first. Refusing to
		// run here would be a regression dressed as rigour — the honesty belongs in
		// the LABEL (`autoLabel` / `honestAutoText`), not in a refusal to chat.
		return this._decision().id ?? this._served?.[0]?.id;
	}

	private _decision(): AutoRouteDecision {
		return autoRouteDecision(this._served?.map(m => m.id));
	}

	/** Re-read the catalogue for the current hop; no client means no hop, hence no models. */
	async refresh(client: Pick<Client, 'listModels'> | undefined, hop: GaggleHopKind | undefined): Promise<void> {
		if (!client || !hop) {
			this._publish([]);
			return;
		}
		try {
			const list = await client.listModels();
			const models = list.data.map(toAgentModelInfo);
			this._publish(models);
			this._logService.info(`gaggle models: ${models.length} model(s) from the ${hop} hop`);
		} catch (err) {
			this._logService.warn(`gaggle models: catalogue unavailable from the ${hop} hop: ${err instanceof Error ? err.message : String(err)}`);
			this._publish([]);
		}
	}

	/**
	 * Publish a resolved catalogue, with the Auto entry FIRST when the plane has
	 * something real to route to. Auto is omitted rather than offered as a dead
	 * option when nothing measured-real is on offer — an Auto that cannot route
	 * is the silent-substitution defect wearing a friendlier label.
	 */
	private _publish(models: readonly IAgentModelInfo[]): void {
		this._served = models;
		const decision = this._decision();
		this._models.set(decision.id ? [autoModelInfo(decision), ...models] : models, undefined);
	}
}
