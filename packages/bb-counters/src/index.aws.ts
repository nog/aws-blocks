// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { getSdkIdentifiers, installClientUserAgent, registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	BatchGetCommand,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
	assertKey,
	assertSettable,
	type Bounds,
	incrementOutOfBounds,
	missingCounter,
	planIncrement,
	resolveBounds,
} from './bounds.js';
import { CountersErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { CountersErrors } from './errors.js';
export type { CountersOptions, IncrementOptions } from './types.js';

import type { CountersOptions, IncrementOptions } from './types.js';

/** Partition key attribute. */
const PK = 'pk';
/** Counter value attribute (a DynamoDB reserved word — always use the `#v` placeholder). */
const VALUE = 'value';
/** BatchGetItem accepts at most 100 keys per request. */
const BATCH_GET_MAX_KEYS = 100;
/** Attempts for keys BatchGetItem returns as unprocessed before giving up. */
const BATCH_GET_MAX_ATTEMPTS = 8;

/**
 * Read the counter value out of the raw (non-unmarshalled) item DynamoDB
 * attaches to a `ConditionalCheckFailedException` when the request set
 * `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`. `undefined` when the item
 * did not exist.
 */
function oldValue(err: unknown): number | undefined {
	const item = (err as { Item?: Record<string, { N?: string }> }).Item;
	const n = item?.[VALUE]?.N;
	return n === undefined ? undefined : Number(n);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Many named integer counters with atomic, retry-free increments, backed by
 * DynamoDB.
 *
 * Each key is an independent counter. A key that has never been written reads
 * as `0`. `increment` / `decrement` are a single atomic server-side update — no
 * read-modify-write loop, no optimistic-locking retries — and never let a
 * counter leave the block's `[min, max]` range.
 *
 * **When to use:** likes / view counts per item, stock levels, usage quotas,
 * rate-limit buckets — anything where many concurrent writers add to a number.
 *
 * **When NOT to use:** for sequential IDs that must be gap-free (a failed
 * request after an increment leaves a gap), or for one extremely hot counter
 * written more than ~1,000 times per second (a single key lives on one
 * DynamoDB partition). Keep the counter separate from the entity it counts and
 * join at read time with `getBatch` — that keeps entity writes and counter
 * writes from contending.
 *
 * **Scaling:** PAY_PER_REQUEST billing. One write per increment; throughput
 * scales with the number of distinct keys.
 *
 * @example
 * ```typescript
 * const stock = new Counters(scope, 'stock', { min: 0 });
 *
 * await stock.increment('sku-1', 10);  // 10
 * await stock.decrement('sku-1');      // 9
 * await stock.get('sku-1');            // 9
 * await stock.get('sku-2');            // 0 (never written)
 * ```
 */
export class Counters extends Scope {
	readonly bbName = BB_NAME;
	private readonly docClient: DynamoDBDocumentClient;
	private readonly bounds: Bounds;

	constructor(scope: ScopeParent, id: string, options?: CountersOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.bounds = resolveBounds(options);
		registerSdkIdentifiers(this.fullId, { tableName: this.fullId.substring(0, 255) });
		const client = new DynamoDBClient({ customUserAgent: this.buildUserAgentChain() });
		installClientUserAgent(client);
		this.docClient = DynamoDBDocumentClient.from(client);
	}

	/**
	 * Atomically add `delta` to a counter and return the new value. A missing
	 * counter starts from `0` (unless `ifExists` is set).
	 *
	 * @param key - The counter's key.
	 * @param delta - Amount to add (a safe integer; negative subtracts). Defaults to `1`.
	 * @param options - `ifExists` to refuse creating a missing counter.
	 * @returns The counter's value after the update.
	 * @throws {CountersErrors.OutOfBounds} If the result would be outside `[min, max]`. Nothing is written.
	 * @throws {CountersErrors.ConditionalCheckFailed} If `ifExists` is set and the counter does not exist.
	 * @throws {CountersErrors.ValidationFailed} If `delta` is not a safe integer or `key` is empty.
	 */
	async increment(key: string, delta = 1, options?: IncrementOptions): Promise<number> {
		assertKey(key);
		const plan = planIncrement(this.bounds, delta);

		// The range check runs against the value BEFORE the update (and
		// condition expressions cannot add), so it compares the old value with
		// the precomputed `[lo, hi]`. A missing attribute fails `BETWEEN`, so
		// creation from the implicit 0 is allowed explicitly — only when
		// `0 + delta` is itself in range.
		const inRange = '#v BETWEEN :lo AND :hi';
		let condition = plan.createOk ? `(attribute_not_exists(#v) OR ${inRange})` : inRange;
		const names: Record<string, string> = { '#v': VALUE };
		if (options?.ifExists) {
			condition = `attribute_exists(#pk) AND ${condition}`;
			names['#pk'] = PK;
		}

		try {
			const result = await this.docClient.send(
				new UpdateCommand({
					TableName: getSdkIdentifiers(this).tableName,
					Key: { [PK]: key },
					UpdateExpression: 'ADD #v :d',
					ConditionExpression: condition,
					ExpressionAttributeNames: names,
					ExpressionAttributeValues: { ':d': delta, ':lo': plan.lo, ':hi': plan.hi },
					ReturnValues: 'UPDATED_NEW',
					ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
				}),
			);
			return result.Attributes?.[VALUE] as number;
		} catch (err: unknown) {
			if (err instanceof Error && err.name === CountersErrors.ConditionalCheckFailed) {
				const current = oldValue(err);
				if (current === undefined && options?.ifExists) throw missingCounter(err);
				throw incrementOutOfBounds(this.bounds, delta, current ?? 0);
			}
			throw err;
		}
	}

	/**
	 * Atomically subtract `delta` from a counter and return the new value.
	 * Equivalent to `increment(key, -delta, options)`.
	 *
	 * @param key - The counter's key.
	 * @param delta - Amount to subtract (a safe integer). Defaults to `1`.
	 * @param options - `ifExists` to refuse creating a missing counter.
	 * @returns The counter's value after the update.
	 * @throws {CountersErrors.OutOfBounds} If the result would be outside `[min, max]`. Nothing is written.
	 * @throws {CountersErrors.ConditionalCheckFailed} If `ifExists` is set and the counter does not exist.
	 * @throws {CountersErrors.ValidationFailed} If `delta` is not a safe integer or `key` is empty.
	 */
	async decrement(key: string, delta = 1, options?: IncrementOptions): Promise<number> {
		return this.increment(key, -delta, options);
	}

	/**
	 * Read a counter. A counter that has never been written (or was deleted)
	 * reads as `0` — counters have no "missing" state distinct from zero.
	 * Reads are strongly consistent: they reflect every completed increment.
	 *
	 * @param key - The counter's key.
	 * @returns The counter's current value.
	 */
	async get(key: string): Promise<number> {
		assertKey(key);
		const result = await this.docClient.send(
			new GetCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Key: { [PK]: key },
				ConsistentRead: true,
			}),
		);
		return (result.Item?.[VALUE] as number | undefined) ?? 0;
	}

	/**
	 * Read many counters at once. Missing counters read as `0`.
	 *
	 * @param keys - The counters' keys. Any length; requests are chunked.
	 * @returns The values, in the same order as `keys`.
	 */
	async getBatch(keys: string[]): Promise<number[]> {
		for (const key of keys) assertKey(key);
		const tableName = getSdkIdentifiers(this).tableName;
		const found = new Map<string, number>();
		const unique = [...new Set(keys)];

		for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
			let pending: Record<string, unknown>[] = unique.slice(i, i + BATCH_GET_MAX_KEYS).map((k) => ({ [PK]: k }));
			for (let attempt = 0; pending.length > 0; attempt++) {
				if (attempt >= BATCH_GET_MAX_ATTEMPTS) {
					throw new Error(
						`Counters.getBatch: ${pending.length} keys still unprocessed after ${attempt} attempts`,
					);
				}
				if (attempt > 0) await sleep(Math.random() * Math.min(1000, 25 * 2 ** attempt));
				const resp = await this.docClient.send(
					new BatchGetCommand({
						RequestItems: { [tableName]: { Keys: pending, ConsistentRead: true } },
					}),
				);
				for (const item of resp.Responses?.[tableName] ?? []) {
					found.set(item[PK] as string, item[VALUE] as number);
				}
				pending = (resp.UnprocessedKeys?.[tableName]?.Keys as Record<string, unknown>[] | undefined) ?? [];
			}
		}
		return keys.map((key) => found.get(key) ?? 0);
	}

	/**
	 * Overwrite a counter with `value` (e.g. a reset to `0`). Creates the
	 * counter if it does not exist.
	 *
	 * @param key - The counter's key.
	 * @param value - The new value (a safe integer within `[min, max]`).
	 * @throws {CountersErrors.OutOfBounds} If `value` is outside `[min, max]`. Nothing is written.
	 * @throws {CountersErrors.ValidationFailed} If `value` is not a safe integer or `key` is empty.
	 */
	async set(key: string, value: number): Promise<void> {
		assertKey(key);
		assertSettable(this.bounds, value);
		await this.docClient.send(
			new PutCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Item: { [PK]: key, [VALUE]: value },
			}),
		);
	}

	/**
	 * Delete a counter. It reads as `0` afterwards. Deleting a missing counter
	 * is a no-op.
	 *
	 * @param key - The counter's key.
	 */
	async delete(key: string): Promise<void> {
		assertKey(key);
		await this.docClient.send(
			new DeleteCommand({
				TableName: getSdkIdentifiers(this).tableName,
				Key: { [PK]: key },
			}),
		);
	}
}
