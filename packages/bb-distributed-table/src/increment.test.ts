// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { DistributedTable, DistributedTableErrors } from './index.mock.js';
import { DistributedTable as AwsDistributedTable } from './index.aws.js';
import { ApiError, isBlocksError, Scope } from '@aws-blocks/core';
import { z } from 'zod';
import type { CounterBounds } from './types.js';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

const postSchema = z.object({
	id: z.string(),
	title: z.string(),
	likeCount: z.number(),
	viewCount: z.number().optional(),
	shares: z.number(),
});
type Post = z.infer<typeof postSchema>;

const eventSchema = z.object({
	stream: z.string(),
	ts: z.number(),
	hits: z.number(),
});

let scopeCounter = 0;
function testScope() {
	return new Scope(`dt-inc-${++scopeCounter}-${Date.now()}`);
}

function postsTable(counters: Record<string, { min?: number; max?: number }> = { likeCount: { min: 0 }, viewCount: {} }) {
	return new DistributedTable(testScope(), 'posts', {
		schema: postSchema,
		key: { partitionKey: 'id' },
		counters: counters as { likeCount: CounterBounds; viewCount: CounterBounds },
	});
}

const post: Post = { id: 'p1', title: 'hello', likeCount: 0, shares: 0 };

function assertBlocksError(fn: () => Promise<unknown>, name: string) {
	return assert.rejects(fn, (e: unknown) => isBlocksError(e, name));
}

// ── Mock behaviour ──────────────────────────────────────────────────────────

describe('increment (mock)', () => {
	test('adds 1 by default, returns the new value and persists it', async () => {
		const posts = postsTable();
		await posts.put(post);
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount'), 1);
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount', { by: 5 }), 6);
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount', { by: -2 }), 4);
		assert.equal((await posts.get({ id: 'p1' }))?.likeCount, 4);
	});

	test('leaves other fields untouched', async () => {
		const posts = postsTable();
		await posts.put(post);
		await posts.increment({ id: 'p1' }, 'likeCount');
		assert.deepEqual(await posts.get({ id: 'p1' }), { ...post, likeCount: 1 });
	});

	test('treats a missing (optional) attribute as 0', async () => {
		const posts = postsTable();
		await posts.put(post);
		assert.equal(await posts.increment({ id: 'p1' }, 'viewCount', { by: 3 }), 3);
	});

	test('throws ItemNotFound (404) for a missing item and creates nothing', async () => {
		const posts = postsTable();
		await assert.rejects(posts.increment({ id: 'nope' }, 'likeCount'), (e: unknown) => {
			assert.ok(isBlocksError(e, DistributedTableErrors.ItemNotFound));
			assert.ok(e instanceof ApiError);
			assert.equal(e.status, 404);
			return true;
		});
		assert.equal(await posts.get({ id: 'nope' }), null);
	});

	test('enforces min: throws CounterOutOfRange (409, not retriable) and writes nothing', async () => {
		const posts = postsTable();
		await posts.put(post);
		await assert.rejects(posts.increment({ id: 'p1' }, 'likeCount', { by: -1 }), (e: unknown) => {
			assert.ok(isBlocksError(e, DistributedTableErrors.CounterOutOfRange));
			assert.ok(e instanceof ApiError);
			assert.equal(e.status, 409);
			assert.equal(e.retriable, false);
			return true;
		});
		assert.equal((await posts.get({ id: 'p1' }))?.likeCount, 0);
	});

	test('enforces max, inclusive', async () => {
		const posts = postsTable({ likeCount: { min: 0, max: 3 } });
		await posts.put(post);
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount', { by: 3 }), 3);
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'likeCount'), DistributedTableErrors.CounterOutOfRange);
	});

	test('a missing attribute counts as 0 for the bounds check too', async () => {
		const posts = postsTable({ viewCount: { min: 0 } });
		await posts.put(post);
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'viewCount', { by: -1 }), DistributedTableErrors.CounterOutOfRange);
		assert.equal((await posts.get({ id: 'p1' }))?.viewCount, undefined);
	});

	test('a stored value already outside the bounds cannot be incremented further out', async () => {
		const posts = postsTable({ likeCount: { max: 10 } });
		await posts.put({ ...post, likeCount: 20 }); // put does not enforce counter bounds
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'likeCount'), DistributedTableErrors.CounterOutOfRange);
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount', { by: -15 }), 5);
	});

	test('concurrent increments never exceed max', async () => {
		const posts = postsTable({ likeCount: { max: 50 } });
		await posts.put(post);
		const results = await Promise.allSettled(
			Array.from({ length: 100 }, () => posts.increment({ id: 'p1' }, 'likeCount')),
		);
		assert.equal(results.filter(r => r.status === 'fulfilled').length, 50);
		assert.equal((await posts.get({ id: 'p1' }))?.likeCount, 50);
	});

	test('rejects an undeclared field at runtime with InvalidQuery', async () => {
		const posts = postsTable();
		await posts.put(post);
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'shares' as any), DistributedTableErrors.InvalidQuery);
	});

	test('rejects a non-integer or unsafe `by` with InvalidQuery', async () => {
		const posts = postsTable();
		await posts.put(post);
		for (const by of [0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			await assertBlocksError(() => posts.increment({ id: 'p1' }, 'likeCount', { by }), DistributedTableErrors.InvalidQuery);
		}
	});

	test('keeps results within the safe-integer range when no bounds are declared', async () => {
		const posts = postsTable({ likeCount: {} });
		await posts.put({ ...post, likeCount: Number.MAX_SAFE_INTEGER });
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'likeCount'), DistributedTableErrors.CounterOutOfRange);
	});

	test('works on a table with a sort key', async () => {
		const events = new DistributedTable(testScope(), 'events', {
			schema: eventSchema,
			key: { partitionKey: 'stream', sortKey: 'ts' },
			counters: { hits: {} },
		});
		await events.put({ stream: 's', ts: 1, hits: 0 });
		await events.put({ stream: 's', ts: 2, hits: 0 });
		assert.equal(await events.increment({ stream: 's', ts: 2 }, 'hits'), 1);
		assert.equal((await events.get({ stream: 's', ts: 1 }))?.hits, 0);
	});
});

describe('counters option validation', () => {
	test('rejects a key attribute', () => {
		assert.throws(() => new DistributedTable(testScope(), 'e', {
			schema: eventSchema,
			key: { partitionKey: 'stream', sortKey: 'ts' },
			counters: { ts: {} } as any,
		}), /key attribute/);
	});

	test('rejects min > max', () => {
		assert.throws(() => postsTable({ likeCount: { min: 5, max: 1 } }), /greater than max/);
	});

	test('rejects non-integer bounds', () => {
		assert.throws(() => postsTable({ likeCount: { max: 1.5 } }), /safe integers/);
	});
});

// ── Compile-time contract ───────────────────────────────────────────────────
// These never run; tsc fails the build if an @ts-expect-error line compiles.

async function _typeChecks() {
	const posts = new DistributedTable(testScope(), 'posts', {
		schema: postSchema,
		key: { partitionKey: 'id' },
		counters: { likeCount: { min: 0 }, viewCount: {} },
	});
	const n: number = await posts.increment({ id: 'p1' }, 'likeCount');
	await posts.increment({ id: 'p1' }, 'viewCount', { by: -1 });
	void n;

	// @ts-expect-error — numeric but not declared in `counters`
	await posts.increment({ id: 'p1' }, 'shares');
	// @ts-expect-error — not a numeric field
	await posts.increment({ id: 'p1' }, 'title');
	// @ts-expect-error — unknown option
	await posts.increment({ id: 'p1' }, 'likeCount', { amount: 1 });

	const plain = new DistributedTable(testScope(), 'plain', { schema: postSchema, key: { partitionKey: 'id' } });
	// @ts-expect-error — no counters declared, so no field is accepted
	await plain.increment({ id: 'p1' }, 'likeCount');

	// @ts-expect-error — non-numeric field cannot be a counter
	new DistributedTable(testScope(), 'x', { schema: postSchema, key: { partitionKey: 'id' }, counters: { title: {} } });
	// @ts-expect-error — typo
	new DistributedTable(testScope(), 'x', { schema: postSchema, key: { partitionKey: 'id' }, counters: { likeCont: {} } });
	// @ts-expect-error — a valid field next to a typo is still rejected
	new DistributedTable(testScope(), 'x', { schema: postSchema, key: { partitionKey: 'id' }, counters: { likeCount: {}, likeCont: {} } });
	// @ts-expect-error — unknown bound option
	new DistributedTable(testScope(), 'x', { schema: postSchema, key: { partitionKey: 'id' }, counters: { likeCount: { minimum: 0 } } });
	// @ts-expect-error — key attribute (numeric sort key) cannot be a counter
	new DistributedTable(testScope(), 'x', { schema: eventSchema, key: { partitionKey: 'stream', sortKey: 'ts' }, counters: { ts: {} } });
}
void _typeChecks;

// ── AWS runtime: command shape and error mapping ────────────────────────────

function awsPosts(counters: Record<string, { min?: number; max?: number }>, send: (command: any) => Promise<any>) {
	const table = new AwsDistributedTable(testScope(), 'posts', {
		schema: postSchema,
		key: { partitionKey: 'id' },
		counters: counters as any,
	});
	(table as any).docClient = { send };
	return table as AwsDistributedTable<Post, { partitionKey: 'id' }, any, any>;
}

function conditionalFailure(item?: Record<string, unknown>) {
	const err = new Error('The conditional request failed') as Error & { Item?: unknown };
	err.name = 'ConditionalCheckFailedException';
	if (item) err.Item = item;
	return err;
}

describe('increment (AWS runtime)', () => {
	test('sends a single ADD with existence + range conditions and returns UPDATED_NEW', async () => {
		const sent: any[] = [];
		const posts = awsPosts({ likeCount: { min: 0, max: 100 } }, async command => {
			sent.push(command.input);
			return { Attributes: { likeCount: 8 } };
		});
		assert.equal(await posts.increment({ id: 'p1' }, 'likeCount', { by: 3 }), 8);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0].Key, { id: 'p1' });
		assert.equal(sent[0].UpdateExpression, 'ADD #c :by');
		assert.equal(
			sent[0].ConditionExpression,
			'attribute_exists(#pk) AND (attribute_not_exists(#c) OR (#c >= :lo AND #c <= :hi))',
		);
		assert.deepEqual(sent[0].ExpressionAttributeNames, { '#pk': 'id', '#c': 'likeCount' });
		assert.deepEqual(sent[0].ExpressionAttributeValues, { ':by': 3, ':lo': -3, ':hi': 97 });
		assert.equal(sent[0].ReturnValues, 'UPDATED_NEW');
		assert.equal(sent[0].ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
	});

	test('allows a missing attribute when 0 + by is in range', async () => {
		const sent: any[] = [];
		const posts = awsPosts({ likeCount: { min: 0 } }, async command => {
			sent.push(command.input);
			return { Attributes: { likeCount: 1 } };
		});
		await posts.increment({ id: 'p1' }, 'likeCount');
		// Undeclared max defaults to MAX_SAFE_INTEGER, so the upper clause keeps the
		// result representable as a JS number.
		assert.equal(
			sent[0].ConditionExpression,
			'attribute_exists(#pk) AND (attribute_not_exists(#c) OR (#c >= :lo AND #c <= :hi))',
		);
		assert.deepEqual(sent[0].ExpressionAttributeValues, { ':by': 1, ':lo': -1, ':hi': Number.MAX_SAFE_INTEGER - 1 });
	});

	test('omits clauses whose limit falls outside the safe-integer range', async () => {
		const sent: any[] = [];
		const posts = awsPosts({ likeCount: {} }, async command => {
			sent.push(command.input);
			return { Attributes: { likeCount: 1 } };
		});
		await posts.increment({ id: 'p1' }, 'likeCount');
		assert.equal(sent[0].ConditionExpression, 'attribute_exists(#pk) AND (attribute_not_exists(#c) OR (#c <= :hi))');
		assert.equal(sent[0].ExpressionAttributeValues[':lo'], undefined);
	});

	test('requires the attribute to exist when 0 + by is out of range', async () => {
		const sent: any[] = [];
		const posts = awsPosts({ likeCount: { min: 0 } }, async command => {
			sent.push(command.input);
			return { Attributes: { likeCount: 0 } };
		});
		await posts.increment({ id: 'p1' }, 'likeCount', { by: -1 });
		assert.equal(sent[0].ConditionExpression, 'attribute_exists(#pk) AND (attribute_exists(#c) AND (#c >= :lo))');
	});

	test('maps a failed condition with no old item to ItemNotFound (404)', async () => {
		const posts = awsPosts({ likeCount: {} }, async () => { throw conditionalFailure(); });
		await assert.rejects(posts.increment({ id: 'p1' }, 'likeCount'), (e: unknown) => {
			assert.ok(isBlocksError(e, DistributedTableErrors.ItemNotFound));
			assert.equal((e as ApiError).status, 404);
			return true;
		});
	});

	test('maps a failed condition on an existing item to CounterOutOfRange (409)', async () => {
		const posts = awsPosts({ likeCount: { max: 1 } }, async () => {
			throw conditionalFailure({ id: { S: 'p1' }, likeCount: { N: '1' } });
		});
		await assert.rejects(posts.increment({ id: 'p1' }, 'likeCount'), (e: unknown) => {
			assert.ok(isBlocksError(e, DistributedTableErrors.CounterOutOfRange));
			assert.equal((e as ApiError).status, 409);
			return true;
		});
	});

	test('reports a non-number stored value as ValidationException, like the mock', async () => {
		const posts = awsPosts({ likeCount: { max: 1 } }, async () => {
			throw conditionalFailure({ id: { S: 'p1' }, likeCount: { S: 'oops' } });
		});
		await assert.rejects(posts.increment({ id: 'p1' }, 'likeCount'), { name: 'ValidationException' });
	});

	test('rejects an undeclared field before sending anything', async () => {
		let sends = 0;
		const posts = awsPosts({ likeCount: {} }, async () => { sends++; return {}; });
		await assertBlocksError(() => posts.increment({ id: 'p1' }, 'shares' as any), DistributedTableErrors.InvalidQuery);
		assert.equal(sends, 0);
	});
});
