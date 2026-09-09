/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MessageKind, ResponsePartKind, TurnState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { carryVerdict, stampCarriedFrom } from '../../browser/projectFolderCarry.js';

suite('Gaggle 123 — project folder carry rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('same folder is not a carry', () => {
		assert.strictEqual(carryVerdict('C:\\repos\\A', 'C:\\repos\\A\\', false), 'same-folder');
	});

	test('a folder that already has a session is foregrounded, not carried (FR-007)', () => {
		assert.strictEqual(carryVerdict('C:\\repos\\A', 'C:\\repos\\B', true), 'foreground');
	});

	test('an empty target is a refusal, never a half-move', () => {
		assert.strictEqual(carryVerdict('C:\\repos\\A', undefined, false), 'refuse');
	});

	test('otherwise the conversation is carried', () => {
		assert.strictEqual(carryVerdict('C:\\repos\\A', 'C:\\repos\\B', false), 'carry');
	});

	test('stampCarriedFrom writes the source folder onto _meta, never the prompt', () => {
		const stamped = stampCarriedFrom([{
			id: 't1',
			message: { text: 'secret prompt', origin: { kind: MessageKind.User } },
			responseParts: [{ kind: ResponsePartKind.Markdown, id: 't1#r', content: 'ok' }],
			usage: undefined,
			state: TurnState.Complete,
		}], 'C:\\repos\\A');
		assert.strictEqual(stamped[0].message._meta?.gaggleCarriedFrom, 'C:\\repos\\A');
		assert.strictEqual(stamped[0].message.text, 'secret prompt');
	});
});
