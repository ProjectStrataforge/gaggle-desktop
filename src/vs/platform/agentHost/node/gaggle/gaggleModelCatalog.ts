/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Client, Model } from '@projectstrataforge/sovereign-router-sdk';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentModelInfo } from '../../common/agentService.js';
import { GAGGLE_PROVIDER_ID, type GaggleHopKind } from './gaggleTypes.js';

// Gaggle 114 — the model list is whatever the SMR catalogue serves for the active
// hop (Principle VI: no vendor pin). Empty only when the catalogue is empty or the
// hop is unreachable; either way one log line says so and nothing throws.

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

export class GaggleModelCatalog extends Disposable {
	private readonly _models = observableValue<readonly IAgentModelInfo[]>('gaggleModels', []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	constructor(private readonly _logService: ILogService) {
		super();
	}

	snapshot(): readonly IAgentModelInfo[] {
		return this._models.get();
	}

	has(modelId: string): boolean {
		return this._models.get().some(m => m.id === modelId);
	}

	/** Re-read the catalogue for the current hop; no client means no hop, hence no models. */
	async refresh(client: Pick<Client, 'listModels'> | undefined, hop: GaggleHopKind | undefined): Promise<void> {
		if (!client || !hop) {
			this._models.set([], undefined);
			return;
		}
		try {
			const list = await client.listModels();
			const models = list.data.map(toAgentModelInfo);
			this._models.set(models, undefined);
			this._logService.info(`gaggle models: ${models.length} model(s) from the ${hop} hop`);
		} catch (err) {
			this._logService.warn(`gaggle models: catalogue unavailable from the ${hop} hop: ${err instanceof Error ? err.message : String(err)}`);
			this._models.set([], undefined);
		}
	}
}
