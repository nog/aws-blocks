// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity. The AWS entry is exercised with its real
 * `DynamoDBDocumentClient` and real commands; a middleware intercepts each
 * request before it leaves the process, records the input, and answers the
 * way DynamoDB would. The DynamoDB semantics these answers stand in for
 * (`ADD` creating from 0, `BETWEEN` failing on a missing attribute, `ALL_OLD`
 * on condition failure, `UPDATED_NEW`) are covered end to end by the sandbox
 * e2e in `test-apps/comprehensive`.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { Counters as AwsCounters, CountersErrors as AwsErrors } from './index.aws.js';
import { CountersErrors as BrowserErrors } from './index.browser.js';
import { CountersErrors as CdkErrors } from './index.cdk.js';
import { Counters as MockCounters, CountersErrors as MockErrors } from './index.mock.js';
import type { CountersOptions } from './types.js';

const root = { id: 'root' } as any;

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

test('error constants are identical across mock / aws / cdk / browser', () => {
	assert.deepEqual(MockErrors, AwsErrors);
	assert.deepEqual(MockErrors, CdkErrors);
	assert.deepEqual(MockErrors, BrowserErrors);
});

/** DynamoDB's ConditionalCheckFailedException, with `ALL_OLD` attached when the item existed. */
function conditionFailed(oldValue?: number): Error {
	const err = new Error('The conditional request failed') as Error & { Item?: unknown };
	err.name = 'ConditionalCheckFailedException';
	if (oldValue !== undefined) err.Item = { pk: { S: 'k' }, value: { N: String(oldValue) } };
	return err;
}

function captureAws(options: CountersOptions | undefined, respond: (input: any) => any = () => ({})) {
	const store = new AwsCounters(root, `aws-${Math.random().toString(36).slice(2)}`, options);
	const sent: any[] = [];
	(store as any).docClient.middlewareStack.add(
		(_next: any) => async (args: any) => {
			sent.push(args.input);
			return { output: respond(args.input) };
		},
		{ step: 'initialize', name: 'counters-parity-intercept', override: true },
	);
	return { store, sent };
}

describe('increment request shape', () => {
	test('a single UpdateItem ADD with UPDATED_NEW and ALL_OLD; returns the new value', async () => {
		const { store, sent } = captureAws(undefined, () => ({ Attributes: { value: 6 } }));
		assert.equal(await store.increment('k', 5), 6);
		assert.equal(sent.length, 1);
		const input = sent[0];
		assert.deepEqual(input.Key, { pk: 'k' });
		assert.equal(input.UpdateExpression, 'ADD #v :d');
		assert.equal(input.ExpressionAttributeNames['#v'], 'value');
		assert.equal(input.ExpressionAttributeValues[':d'], 5);
		assert.equal(input.ReturnValues, 'UPDATED_NEW');
		assert.equal(input.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
	});

	test('bounds are precomputed as bigint (lo = min - delta, hi = max - delta)', async () => {
		const { store, sent } = captureAws({ min: 0, max: 50 }, () => ({ Attributes: { value: 1 } }));
		await store.increment('k', 3);
		const values = sent[0].ExpressionAttributeValues;
		assert.equal(values[':lo'], -3n);
		assert.equal(values[':hi'], 47n);
	});

	test('default bounds survive deltas that push lo/hi outside the safe range', async () => {
		const { store, sent } = captureAws(undefined, () => ({ Attributes: { value: 1 } }));
		await store.increment('k', 1);
		await store.decrement('k', 1);
		assert.equal(sent[0].ExpressionAttributeValues[':lo'], BigInt(Number.MIN_SAFE_INTEGER) - 1n);
		assert.equal(sent[1].ExpressionAttributeValues[':hi'], BigInt(Number.MAX_SAFE_INTEGER) + 1n);
	});

	test('creation from 0 is allowed only when the delta itself is in range', async () => {
		const { store, sent } = captureAws({ min: 0 }, () => ({ Attributes: { value: 1 } }));
		await store.increment('k', 1);
		assert.equal(sent[0].ConditionExpression, '(attribute_not_exists(#v) OR #v BETWEEN :lo AND :hi)');
		await store.decrement('k', 1).catch(() => {});
		assert.equal(sent[1].ConditionExpression, '#v BETWEEN :lo AND :hi');
	});

	test('ifExists adds attribute_exists(#pk)', async () => {
		const { store, sent } = captureAws(undefined, () => ({ Attributes: { value: 1 } }));
		await store.increment('k', 1, { ifExists: true });
		assert.equal(
			sent[0].ConditionExpression,
			'attribute_exists(#pk) AND (attribute_not_exists(#v) OR #v BETWEEN :lo AND :hi)',
		);
		assert.equal(sent[0].ExpressionAttributeNames['#pk'], 'pk');
	});

	test('invalid input is rejected before any request is sent', async () => {
		const { store, sent } = captureAws(undefined);
		await assert.rejects(
			() => store.increment('k', 1.5),
			(e) => isBlocksError(e, AwsErrors.ValidationFailed),
		);
		await assert.rejects(
			() => store.increment(''),
			(e) => isBlocksError(e, AwsErrors.ValidationFailed),
		);
		await assert.rejects(
			() => store.set('k', Number.MAX_SAFE_INTEGER + 1),
			(e) => isBlocksError(e, AwsErrors.ValidationFailed),
		);
		assert.equal(sent.length, 0);
	});
});

describe('error mapping matches the mock', () => {
	async function errorOf(fn: () => Promise<unknown>): Promise<ApiError> {
		try {
			await fn();
		} catch (e) {
			assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
			return e;
		}
		assert.fail('expected a rejection');
	}

	function same(a: ApiError, b: ApiError) {
		assert.equal(a.name, b.name);
		assert.equal(a.status, b.status);
		assert.equal(a.retriable, b.retriable);
		assert.equal(a.message, b.message);
	}

	test('out of bounds on an existing counter', async () => {
		const mock = new MockCounters(root, 'oob', { min: 0 });
		await mock.set('k', 0);
		const mockErr = await errorOf(() => mock.decrement('k'));

		const { store } = captureAws({ min: 0 }, () => {
			throw conditionFailed(0);
		});
		const awsErr = await errorOf(() => store.decrement('k'));

		same(mockErr, awsErr);
		assert.equal(awsErr.name, AwsErrors.OutOfBounds);
		assert.equal(awsErr.status, 409);
	});

	test('out of bounds on a missing counter reports current value 0', async () => {
		const mockErr = await errorOf(() => new MockCounters(root, 'oob2', { min: 0 }).decrement('k'));
		const { store } = captureAws({ min: 0 }, () => {
			throw conditionFailed();
		});
		same(mockErr, await errorOf(() => store.decrement('k')));
	});

	test('ifExists on a missing counter', async () => {
		const mockErr = await errorOf(() => new MockCounters(root, 'missing').increment('k', 1, { ifExists: true }));
		const { store } = captureAws(undefined, () => {
			throw conditionFailed();
		});
		const awsErr = await errorOf(() => store.increment('k', 1, { ifExists: true }));
		same(mockErr, awsErr);
		assert.equal(awsErr.name, AwsErrors.ConditionalCheckFailed);
	});

	test('ifExists on an existing counter that would leave the bounds is OutOfBounds', async () => {
		const mock = new MockCounters(root, 'both', { max: 1 });
		await mock.set('k', 1);
		const mockErr = await errorOf(() => mock.increment('k', 1, { ifExists: true }));
		const { store } = captureAws({ max: 1 }, () => {
			throw conditionFailed(1);
		});
		const awsErr = await errorOf(() => store.increment('k', 1, { ifExists: true }));
		same(mockErr, awsErr);
		assert.equal(awsErr.name, AwsErrors.OutOfBounds);
	});

	test('set out of bounds', async () => {
		const mockErr = await errorOf(() => new MockCounters(root, 'set', { max: 5 }).set('k', 6));
		const { store, sent } = captureAws({ max: 5 });
		same(mockErr, await errorOf(() => store.set('k', 6)));
		assert.equal(sent.length, 0);
	});

	test('other DynamoDB errors propagate unchanged', async () => {
		const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' });
		const { store } = captureAws(undefined, () => {
			throw throttled;
		});
		await assert.rejects(
			() => store.increment('k'),
			(e) => e === throttled,
		);
	});
});

describe('reads', () => {
	test('get is strongly consistent and reads a missing counter as 0', async () => {
		const { store, sent } = captureAws(undefined, () => ({}));
		assert.equal(await store.get('k'), 0);
		assert.equal(sent[0].ConsistentRead, true);
		assert.equal(await new MockCounters(root, 'g').get('k'), 0);
	});

	test('getBatch chunks at 100 keys, retries unprocessed keys, keeps order and reads missing as 0', async () => {
		const keys = Array.from({ length: 150 }, (_, i) => `k${i}`);
		let first = true;
		const { store, sent } = captureAws(undefined, (input) => {
			const [table] = Object.keys(input.RequestItems);
			const requested: { pk: string }[] = input.RequestItems[table].Keys;
			// Answer every key except k0..k9 (absent) and, the first time, leave k10 unprocessed.
			const unprocessed = first ? requested.filter((k) => k.pk === 'k10') : [];
			first = false;
			const items = requested
				.filter((k) => !/^k\d$/.test(k.pk) && !unprocessed.includes(k))
				.map((k) => ({ pk: k.pk, value: Number(k.pk.slice(1)) }));
			return {
				Responses: { [table]: items },
				UnprocessedKeys: unprocessed.length ? { [table]: { Keys: unprocessed } } : {},
			};
		});
		const values = await store.getBatch([...keys, 'k42']);
		assert.equal(sent.length, 3); // 100 + 1 retry + 50
		assert.ok(sent.every((s) => Object.values<any>(s.RequestItems)[0].ConsistentRead === true));
		assert.ok(sent.every((s) => Object.values<any>(s.RequestItems)[0].Keys.length <= 100));
		assert.deepEqual(values, [...keys.map((k) => (/^k\d$/.test(k) ? 0 : Number(k.slice(1)))), 42]);
	});
});
