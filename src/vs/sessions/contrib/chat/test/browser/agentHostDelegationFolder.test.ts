/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';

// Gaggle 123 — "continue this conversation in another project".
//
// The delegation handler is registered as a command against live workbench
// services, so these assert the DECISION RULES it encodes rather than driving the
// command itself. Each rule below is one the feature would silently lose without
// anybody noticing, which is exactly the defect class this feature was re-scoped
// to avoid: a carry that looks right and lands somewhere else, or nowhere.

/** The folder the target session is created in. Mirrors the handler's choice. */
export function chooseDelegationFolder(
	requested: URI | undefined,
	sourceFolder: URI | undefined,
): URI | undefined {
	return requested ?? sourceFolder;
}

/**
 * Whether a create must go through `openNewSession` (the workspace-trust gate)
 * rather than the direct `createNewSession`.
 */
export function requiresTrustGate(requested: URI | undefined): boolean {
	return requested !== undefined;
}

/** What the operator is told when the target could not be opened. */
export function refusalReason(trustDeclined: boolean): string {
	return trustDeclined ? 'workspace trust was declined' : 'the folder could not be opened';
}

suite('Gaggle 123 — continue in another project', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const A = URI.file('/repos/alpha');
	const B = URI.file('/repos/beta');

	test('a requested folder wins; without one the source folder is reused', () => {
		// The pre-123 behaviour is the `undefined` case, and it must not drift:
		// "continue in another AGENT" still lands in the same project.
		assert.strictEqual(chooseDelegationFolder(undefined, A)?.toString(), A.toString());
		assert.strictEqual(chooseDelegationFolder(B, A)?.toString(), B.toString());
		// Neither available is not a carry at all.
		assert.strictEqual(chooseDelegationFolder(undefined, undefined), undefined);
	});

	test('changing the folder makes the workspace-trust gate mandatory', () => {
		// The direct create is safe today ONLY because the folder was already
		// trusted — it was the source session's own. The moment the folder can
		// differ, skipping the gate would open an untrusted folder silently.
		assert.strictEqual(requiresTrustGate(B), true);
		assert.strictEqual(requiresTrustGate(undefined), false);
	});

	test('a refusal names which refusal it was', () => {
		// Declining trust and failing to resolve are different facts, and an
		// operator who declined trust must not be told the folder was broken.
		assert.match(refusalReason(true), /trust/i);
		assert.match(refusalReason(false), /could not be opened/i);
		assert.notStrictEqual(refusalReason(true), refusalReason(false));
	});

	test('no refusal message leaks a path or credential material', () => {
		for (const declined of [true, false]) {
			const message = `Could not continue this conversation there: ${refusalReason(declined)}.`;
			assert.ok(!message.includes('/repos/'), 'a refusal names the reason, never the path');
			assert.ok(!/Bearer|api[_-]?key|smr_/i.test(message));
		}
	});
});
