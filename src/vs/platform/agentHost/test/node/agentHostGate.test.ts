/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { copilotCliResolvable } from '../../node/copilot/copilotAgent.js';

// Gaggle 114 (provider honesty): built products register the Copilot provider only
// when its CLI actually resolves. This pins the resolvability check the two mains
// gate on — the same candidate list the provider itself walks.

suite('agent host provider gate (114)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	setup(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), 'gaggle-gate-'));
	});
	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('no @github/copilot packages → not resolvable (the built Goose case)', () => {
		assert.strictEqual(copilotCliResolvable(URI.file(root)), false);
	});

	test('platform package present → resolvable', () => {
		const dir = join(root, '@github', `copilot-${process.platform}-${process.arch}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(join(dir, 'index.js'), '// cli');
		assert.strictEqual(copilotCliResolvable(URI.file(root)), true);
	});

	test('legacy top-level package present → resolvable', () => {
		const dir = join(root, '@github', 'copilot');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(join(dir, 'index.js'), '// cli');
		assert.strictEqual(copilotCliResolvable(URI.file(root)), true);
	});

	test('an empty package directory without index.js is not resolvable', () => {
		fs.mkdirSync(join(root, '@github', 'copilot'), { recursive: true });
		assert.strictEqual(copilotCliResolvable(URI.file(root)), false);
	});
});
