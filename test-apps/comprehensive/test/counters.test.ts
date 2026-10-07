// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

// Error names — match CountersErrors. Imported as strings because the test
// runs under the `browser` condition where bb-counters only exports a stub.
const OutOfBounds = 'CounterOutOfBoundsException';
const ConditionalCheckFailed = 'ConditionalCheckFailedException';

function rejectsWith(name: string) {
	return (e: unknown) => {
		assert.ok(isBlocksError(e, name), `Expected ${name}, got ${e}`);
		assert.ok(e instanceof ApiError);
		assert.strictEqual(e.status, 409);
		return true;
	};
}

// The app's `counters` instance is bounded to [0, 10].
export function countersTests(getApi: () => typeof apiType) {
	describe('Counters', () => {
		const fresh = () => `ctr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		test('a missing counter reads as 0', async () => {
			const api = getApi();
			assert.strictEqual(await api.counterGet(fresh()), 0);
		});

		test('increment / decrement return the new value', async () => {
			const api = getApi();
			const key = fresh();
			const one: number = await api.counterIncrement(key);
			assert.strictEqual(one, 1);
			assert.strictEqual(await api.counterIncrement(key, 4), 5);
			assert.strictEqual(await api.counterDecrement(key, 2), 3);
			assert.strictEqual(await api.counterGet(key), 3);
			await api.counterDelete(key);
		});

		test('decrement below min is rejected without writing', async () => {
			const api = getApi();
			const key = fresh();
			await assert.rejects(() => api.counterDecrement(key), rejectsWith(OutOfBounds));
			assert.strictEqual(await api.counterGet(key), 0);
		});

		test('concurrent increments stop exactly at max', async () => {
			const api = getApi();
			const key = fresh();
			const results = await Promise.allSettled(Array.from({ length: 20 }, () => api.counterIncrement(key)));
			const ok = results.filter((r) => r.status === 'fulfilled').length;
			assert.strictEqual(ok, 10);
			for (const r of results) {
				if (r.status === 'rejected') rejectsWith(OutOfBounds)(r.reason);
			}
			assert.strictEqual(await api.counterGet(key), 10);
			await api.counterDelete(key);
		});

		test('ifExists refuses to create a missing counter', async () => {
			const api = getApi();
			const key = fresh();
			await assert.rejects(() => api.counterIncrement(key, 1, { ifExists: true }), rejectsWith(ConditionalCheckFailed));
			await api.counterSet(key, 0);
			assert.strictEqual(await api.counterIncrement(key, 1, { ifExists: true }), 1);
			await api.counterDelete(key);
		});

		test('set enforces bounds; getBatch keeps order', async () => {
			const api = getApi();
			const a = fresh();
			const b = fresh();
			await assert.rejects(() => api.counterSet(a, 11), rejectsWith(OutOfBounds));
			await api.counterSet(a, 7);
			await api.counterIncrement(b, 2);
			const values: number[] = await api.counterGetBatch([b, fresh(), a]);
			assert.deepStrictEqual(values, [2, 0, 7]);
			await api.counterDelete(a);
			await api.counterDelete(b);
		});
	});
}
