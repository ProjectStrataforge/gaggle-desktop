/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

// Gaggle 114 / constitution Principle I: every generative call goes through the SMR
// client. A foundation-model provider SDK reachable from the Gaggle provider is a
// hard blocker, so this suite walks the provider's compiled sources and fails on
// any such import. The only scoped runtime package it may import is
// @projectstrataforge/* (the SMR and SovereignDB SDKs).

const FORBIDDEN = [
	'@anthropic-ai/',
	'openai',
	'@google/',
	'@google-cloud/',
	'@mistralai/',
	'cohere',
	'@aws-sdk/client-bedrock',
	'@azure/openai',
	'@github/copilot',
];

function importSpecifiers(source: string): string[] {
	const out: string[] = [];
	const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		out.push(m[1] ?? m[2] ?? m[3]);
	}
	return out;
}

suite('gaggle provider — no foundation-model provider SDK (114 / Principle I)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const gaggleDir = FileAccess.asFileUri('vs/platform/agentHost/node/gaggle').fsPath;

	test('the provider directory exists in the build', () => {
		assert.ok(fs.existsSync(gaggleDir), `missing ${gaggleDir}`);
	});

	test('no file under node/gaggle imports a provider SDK', () => {
		const files = fs.readdirSync(gaggleDir).filter(f => f.endsWith('.js'));
		assert.ok(files.length > 0, 'no compiled provider files found');
		const offenders: string[] = [];
		for (const file of files) {
			const source = fs.readFileSync(join(gaggleDir, file), 'utf8');
			for (const spec of importSpecifiers(source)) {
				const bare = spec.replace(/^node:/, '');
				if (FORBIDDEN.some(f => bare === f || bare.startsWith(f))) {
					offenders.push(`${file} → ${spec}`);
				}
				if (bare.startsWith('@') && !bare.startsWith('@projectstrataforge/')) {
					offenders.push(`${file} → ${spec} (scoped package outside @projectstrataforge)`);
				}
			}
		}
		assert.deepStrictEqual(offenders, [], `forbidden imports: ${offenders.join('; ')}`);
	});

	test('the import walker sees the specifiers it must judge', () => {
		const sample = `import { Client } from '@projectstrataforge/sovereign-router-sdk';\nimport x from "openai";\nconst y = require('cohere');`;
		assert.deepStrictEqual(importSpecifiers(sample), ['@projectstrataforge/sovereign-router-sdk', 'openai', 'cohere']);
	});
});
