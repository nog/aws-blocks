// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { Counters, CountersErrors } from './index.mock.js';

const root = { id: 'root' } as any;

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

function isError(name: string, status?: number) {
	return (err: unknown) => {
		assert.ok(isBlocksError(err, name), `expected ${name}, got ${String(err)}`);
		if (status !== undefined) {
			assert.ok(err instanceof ApiError);
			assert.equal(err.status, status);
			assert.equal(err.retriable, false);
		}
		return true;
	};
}

// ── Basics ──────────────────────────────────────────────────────────────────

test('a counter that was never written reads as 0', async () => {
	const c = new Counters(root, 'c');
	assert.equal(await c.get('missing'), 0);
});

test('increment starts from 0, defaults to +1, and returns the new value', async () => {
	const c = new Counters(root, 'c');
	assert.equal(await c.increment('k'), 1);
	assert.equal(await c.increment('k', 5), 6);
	assert.equal(await c.get('k'), 6);
});

test('negative delta subtracts; decrement subtracts', async () => {
	const c = new Counters(root, 'c');
	await c.increment('k', 10);
	assert.equal(await c.increment('k', -3), 7);
	assert.equal(await c.decrement('k'), 6);
	assert.equal(await c.decrement('k', 4), 2);
});

test('increment by 0 returns the current value', async () => {
	const c = new Counters(root, 'c');
	await c.set('k', 4);
	assert.equal(await c.increment('k', 0), 4);
});

test('set overwrites and delete resets to 0', async () => {
	const c = new Counters(root, 'c');
	await c.increment('k', 3);
	await c.set('k', 100);
	assert.equal(await c.get('k'), 100);
	await c.delete('k');
	assert.equal(await c.get('k'), 0);
	await c.delete('k'); // no-op
});

test('getBatch preserves order, repeats, and reads missing keys as 0', async () => {
	const c = new Counters(root, 'c');
	await c.set('a', 1);
	await c.set('b', 2);
	assert.deepEqual(await c.getBatch(['b', 'missing', 'a', 'b']), [2, 0, 1, 2]);
	assert.deepEqual(await c.getBatch([]), []);
});

test('counters are independent per block instance', async () => {
	const a = new Counters(root, 'a');
	const b = new Counters(root, 'b');
	await a.increment('k', 2);
	assert.equal(await b.get('k'), 0);
});

test('state persists across instances (on-disk mock)', async () => {
	await new Counters(root, 'persist').increment('k', 7);
	assert.equal(await new Counters(root, 'persist').get('k'), 7);
});

test('concurrent increments are not lost', async () => {
	const c = new Counters(root, 'c');
	await Promise.all(Array.from({ length: 100 }, () => c.increment('k')));
	assert.equal(await c.get('k'), 100);
});

// ── ifExists ────────────────────────────────────────────────────────────────

test('ifExists refuses to create a missing counter and writes nothing', async () => {
	const c = new Counters(root, 'c');
	await assert.rejects(
		() => c.increment('k', 1, { ifExists: true }),
		isError(CountersErrors.ConditionalCheckFailed, 409),
	);
	await assert.rejects(
		() => c.decrement('k', 1, { ifExists: true }),
		isError(CountersErrors.ConditionalCheckFailed, 409),
	);
	assert.equal(await c.get('k'), 0);
	await c.set('k', 0);
	assert.equal(await c.increment('k', 1, { ifExists: true }), 1);
});

// ── Bounds ──────────────────────────────────────────────────────────────────

test('min: decrement below the floor is rejected without writing', async () => {
	const stock = new Counters(root, 'stock', { min: 0 });
	await stock.increment('sku', 2);
	assert.equal(await stock.decrement('sku', 2), 0);
	await assert.rejects(() => stock.decrement('sku'), isError(CountersErrors.OutOfBounds, 409));
	assert.equal(await stock.get('sku'), 0);
});

test('min: a missing counter cannot be created below the floor', async () => {
	const stock = new Counters(root, 'stock', { min: 0 });
	await assert.rejects(() => stock.decrement('sku'), isError(CountersErrors.OutOfBounds));
	assert.deepEqual(await stock.getBatch(['sku']), [0]);
});

test('max: increments stop exactly at the ceiling', async () => {
	const quota = new Counters(root, 'quota', { min: 0, max: 50 });
	const results = await Promise.allSettled(Array.from({ length: 100 }, () => quota.increment('user')));
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 50);
	assert.equal(await quota.get('user'), 50);
});

test('max: an increment landing exactly on the bound succeeds; one past fails', async () => {
	const c = new Counters(root, 'c', { min: -5, max: 5 });
	assert.equal(await c.increment('k', 5), 5);
	await assert.rejects(() => c.increment('k'), isError(CountersErrors.OutOfBounds));
	assert.equal(await c.increment('k', -10), -5);
	await assert.rejects(() => c.increment('k', -1), isError(CountersErrors.OutOfBounds));
});

test('a missing counter may be created by a delta that is itself in range, even when 0 is not', async () => {
	const c = new Counters(root, 'c', { min: 10, max: 20 });
	assert.equal(await c.get('k'), 0);
	await assert.rejects(() => c.increment('k', 5), isError(CountersErrors.OutOfBounds));
	assert.equal(await c.increment('k', 15), 15);
});

test('the out-of-bounds message reports the current value and the range', async () => {
	const c = new Counters(root, 'c', { min: 0, max: 3 });
	await c.set('k', 3);
	await assert.rejects(
		() => c.increment('k'),
		(err: Error) => {
			assert.match(err.message, /current value 3/);
			assert.match(err.message, /\[0, 3\]/);
			return true;
		},
	);
});

test('set enforces the bounds', async () => {
	const c = new Counters(root, 'c', { min: 0, max: 10 });
	await assert.rejects(() => c.set('k', 11), isError(CountersErrors.OutOfBounds));
	await assert.rejects(() => c.set('k', -1), isError(CountersErrors.OutOfBounds));
	assert.equal(await c.get('k'), 0);
});

test('without bounds, values are clamped to the safe-integer range', async () => {
	const c = new Counters(root, 'c');
	await c.set('k', Number.MAX_SAFE_INTEGER - 1);
	assert.equal(await c.increment('k'), Number.MAX_SAFE_INTEGER);
	await assert.rejects(() => c.increment('k'), isError(CountersErrors.OutOfBounds));
	await c.set('n', Number.MIN_SAFE_INTEGER);
	await assert.rejects(() => c.decrement('n'), isError(CountersErrors.OutOfBounds));
	// The default floor is far away: an ordinary increment must not trip it.
	assert.equal(await c.increment('fresh', 3), 3);
});

// ── Validation ──────────────────────────────────────────────────────────────

test('non-integer or unsafe deltas and values are rejected', async () => {
	const c = new Counters(root, 'c');
	for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		await assert.rejects(() => c.increment('k', bad), isError(CountersErrors.ValidationFailed));
		await assert.rejects(() => c.set('k', bad), isError(CountersErrors.ValidationFailed));
	}
	assert.equal(await c.get('k'), 0);
});

test('empty keys are rejected', async () => {
	const c = new Counters(root, 'c');
	await assert.rejects(() => c.increment(''), isError(CountersErrors.ValidationFailed));
	await assert.rejects(() => c.get(''), isError(CountersErrors.ValidationFailed));
	await assert.rejects(() => c.getBatch(['a', '']), isError(CountersErrors.ValidationFailed));
});

test('invalid bounds fail at construction', () => {
	assert.throws(() => new Counters(root, 'x', { min: 5, max: 4 }), isError(CountersErrors.ValidationFailed));
	assert.throws(() => new Counters(root, 'y', { min: 0.5 }), isError(CountersErrors.ValidationFailed));
	assert.throws(
		() => new Counters(root, 'z', { max: Number.MAX_SAFE_INTEGER + 1 }),
		isError(CountersErrors.ValidationFailed),
	);
	assert.doesNotThrow(() => new Counters(root, 'eq', { min: 3, max: 3 }));
});
