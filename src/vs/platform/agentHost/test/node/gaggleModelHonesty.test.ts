/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import {
	autoRouteLabel, catalogIdKind, honestAutoText, pickCatalogId,
} from '../../node/gaggle/gaggleCatalogHonesty.js';
import { GAGGLE_AUTO_MODEL_ID, GaggleModelCatalog } from '../../node/gaggle/gaggleModelCatalog.js';

// Gaggle 120 — the picker offered two measured-stub models and hid the routing
// profile behind "Other Models", so the obvious path landed on something that
// answers with `latency_ms=0`. These assert that Auto resolves by measured
// behaviour rather than by a model NAME, that an unresolved catalogue is not the
// same claim as an empty one, and — the part that protects every future
// diagnosis — that the word `auto` never reaches the turn record.

/** A catalogue whose ids are `ids`; enough of `listModels` for the catalogue. */
function client(ids: readonly string[]): { listModels(): Promise<{ data: { id: string; object: 'model'; created: number; ownedBy: string }[]; hasMore: boolean; object: 'list' }> } {
	return {
		listModels: async () => ({
			object: 'list' as const,
			hasMore: false,
			data: ids.map(id => ({ id, object: 'model' as const, created: 0, ownedBy: 'test' })),
		}),
	};
}

suite('Gaggle 120 — the catalogue is honest about what it can serve', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a name is not proof — ids are classified by what they were measured to do', () => {
		assert.strictEqual(catalogIdKind('router-default'), 'measured-real');
		assert.strictEqual(catalogIdKind('claude-sonnet-4-6'), 'measured-stub');
		assert.strictEqual(catalogIdKind('gpt-4o-mini'), 'measured-stub');
		assert.strictEqual(catalogIdKind('something-new'), 'unknown');
	});

	test('Auto prefers a measured-real id and NEVER falls back to a stub', () => {
		// The exact catalogue measured on the assigned prod plane, in the order it
		// arrives. The two stubs come first, which is why the short list offered
		// them and why an operator following the obvious path saw latency_ms=0.
		assert.strictEqual(
			pickCatalogId(['gpt-4o-mini', 'claude-sonnet-4-6', 'router-default', 'sol']),
			'router-default',
		);
		// Stubs only: no pick at all. An unknown id is preferred over a known stub,
		// because unknown might answer and a measured stub will not.
		assert.strictEqual(pickCatalogId(['gpt-4o-mini', 'claude-sonnet-4-6']), undefined);
		assert.strictEqual(pickCatalogId(['claude-sonnet-4-6', 'brand-new']), 'brand-new');
	});

	test('unresolved is not empty, and empty is not "stubs"', () => {
		// The distinction this feature exists for: the credential lands 66s-5m37s
		// after startup (#1410), and for that whole window an empty list read as
		// "no models available".
		assert.strictEqual(autoRouteLabel(undefined), 'unresolved');
		assert.strictEqual(autoRouteLabel([]), 'unavailable-empty');
		assert.strictEqual(autoRouteLabel(['gpt-4o-mini']), 'unavailable-stubs');
		assert.strictEqual(autoRouteLabel(['router-default']), 'ready');
	});

	test('the label never names a host, a URL or a credential', () => {
		const texts = [
			honestAutoText('unresolved'),
			honestAutoText('unavailable-empty'),
			honestAutoText('unavailable-stubs'),
			honestAutoText('ready', 'router-default'),
		];
		for (const text of texts) {
			assert.ok(!/https?:|127\.0\.0\.1|:\d{4}|Bearer|api[_-]?key/i.test(text), `leaked in: ${text}`);
		}
		assert.strictEqual(honestAutoText('ready', 'router-default'), 'Auto (router-default)');
	});
});

suite('Gaggle 120 — the model catalogue', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Auto is offered FIRST when the plane has something real to route to', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		await catalog.refresh(client(['gpt-4o-mini', 'router-default']), 'remote');

		const ids = catalog.snapshot().map(m => m.id);
		assert.deepStrictEqual(ids, [GAGGLE_AUTO_MODEL_ID, 'gpt-4o-mini', 'router-default']);
		// The vendor picker promotes a model whose id is exactly `auto`; without
		// this entry the routing profile sits behind "Other Models".
		assert.strictEqual(catalog.autoLabel, 'ready');
		catalog.dispose();
	});

	test('Auto is OMITTED rather than offered as a dead option', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		await catalog.refresh(client(['gpt-4o-mini', 'claude-sonnet-4-6']), 'remote');

		// An Auto that cannot route is the silent-substitution defect wearing a
		// friendlier label, so it is not offered at all.
		assert.deepStrictEqual(catalog.snapshot().map(m => m.id), ['gpt-4o-mini', 'claude-sonnet-4-6']);
		assert.strictEqual(catalog.autoLabel, 'unavailable-stubs');
		catalog.dispose();
	});

	test('unresolved and resolved-empty are different states', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		assert.strictEqual(catalog.resolved, false, 'nothing has been read yet');
		assert.strictEqual(catalog.autoLabel, 'unresolved');

		await catalog.refresh(undefined, undefined);
		assert.strictEqual(catalog.resolved, true, 'no hop is still an answer');
		assert.strictEqual(catalog.autoLabel, 'unavailable-empty');
		catalog.dispose();
	});

	test('`auto` resolves to the serving model, and the word never survives', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		await catalog.refresh(client(['gpt-4o-mini', 'router-default']), 'remote');

		// FR-005: the turn records what actually served. `hop=… model=… latency_ms=…`
		// is what made this whole class of problem diagnosable, and routing must not
		// hide what answered.
		assert.strictEqual(catalog.resolveModelId(GAGGLE_AUTO_MODEL_ID), 'router-default');
		assert.strictEqual(catalog.resolveModelId(undefined), 'router-default');
		// An explicit choice is honoured exactly, stub or not — the operator asked.
		assert.strictEqual(catalog.resolveModelId('gpt-4o-mini'), 'gpt-4o-mini');
		catalog.dispose();
	});

	test('a stub-only plane still runs — the honesty is in the label, not a refusal', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		await catalog.refresh(client(['gpt-4o-mini']), 'local');

		// Refusing to chat because the measured-real list has no entry for this
		// plane would be a regression dressed as rigour. The lists were measured on
		// a REMOTE plane; the local Slim stubs ids that are real elsewhere.
		assert.strictEqual(catalog.resolveModelId(undefined), 'gpt-4o-mini');
		assert.strictEqual(catalog.autoLabel, 'unavailable-stubs');
		catalog.dispose();
	});

	test('the selected model is offered back for validation, Auto included', async () => {
		const catalog = new GaggleModelCatalog(new NullLogService());
		await catalog.refresh(client(['router-default']), 'remote');

		// `changeModel` rejects an id the catalogue does not have; Auto must not be
		// rejected by the very surface that offers it.
		assert.ok(catalog.has(GAGGLE_AUTO_MODEL_ID));
		assert.ok(catalog.has('router-default'));
		assert.ok(!catalog.has('never-advertised'));
		catalog.dispose();
	});
});
