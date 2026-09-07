/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

// Gaggle 114 — Goose routes every generative call through the Sovereign Model
// Router. This asserts the END STATE of both agent-host mains rather than the
// absence of some earlier expression: the Gaggle provider IS registered, and the
// vendor Copilot provider is registered in no build — its CLI is stripped by
// design, so it could never create a session.
//
// The vendor Claude and Codex providers are still registered here but are gated
// at runtime on `product.agentSdks.*`, which Goose leaves undefined; that is
// product configuration, not this file's business.
//
// Reads the sources, because the mains are process entry points: importing one
// would start an agent host.

const MAINS = ['agentHostMain.ts', 'agentHostServerMain.ts'] as const;

function mainSource(name: string): string {
	// Tests run from `out/`; the mains are TypeScript, so read them from `src/`.
	// `FileAccess` resolves against the output root, and the source tree is its
	// sibling — deriving it that way keeps this working wherever the repo lives.
	const outRoot = FileAccess.asFileUri('').fsPath;
	return fs.readFileSync(join(outRoot, '..', 'src', 'vs', 'platform', 'agentHost', 'node', name), 'utf8');
}

/** Registration calls, with comments stripped so prose about a provider is not a match. */
function registrations(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	return [...code.matchAll(/registerProvider\(([^;]*?)\)\s*;/gs)].map(m => m[1].replace(/\s+/g, ' ').trim());
}

suite('agent host provider registration (114)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const name of MAINS) {
		test(`${name} registers the Gaggle provider`, () => {
			const found = registrations(mainSource(name));
			// The electron main instantiates inline; the server main registers a
			// local. Match the name either way.
			assert.ok(
				found.some(call => /gaggleagent/i.test(call)),
				`${name} must register the Gaggle provider; found: ${JSON.stringify(found)}`,
			);
		});

		test(`${name} registers no Copilot provider, in any build`, () => {
			const found = registrations(mainSource(name));
			assert.deepStrictEqual(
				found.filter(call => /copilotagent/i.test(call)),
				[],
				`${name} must not register the Copilot provider`,
			);
		});

		test(`${name} gates no provider on a stripped Copilot CLI`, () => {
			// The old shape registered Copilot behind `copilotCliResolvable(...)`.
			// Removing the provider removed the need for the gate; if the gate comes
			// back, so has the provider.
			const code = mainSource(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
			assert.doesNotMatch(code, /copilotCliResolvable/, `${name} still gates on the Copilot CLI`);
		});
	}
});
