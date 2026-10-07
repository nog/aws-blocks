// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeParent } from '@aws-blocks/core';
import { registerSdkIdentifiers, Scope } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import {
	allows,
	assertKey,
	assertSettable,
	type Bounds,
	incrementOutOfBounds,
	missingCounter,
	planIncrement,
	resolveBounds,
} from './bounds.js';
import { BB_NAME, BB_VERSION } from './version.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { CountersErrors } from './errors.js';
export type { CountersOptions, IncrementOptions } from './types.js';

import type { CountersOptions, IncrementOptions } from './types.js';

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
 * This is the local-dev / test implementation: state lives in memory and is
 * persisted to `.bb-data/{fullId}/counters.json`.
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
	private readonly filePath: string;
	private readonly data: Map<string, number>;
	private readonly bounds: Bounds;

	constructor(scope: ScopeParent, id: string, options?: CountersOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.bounds = resolveBounds(options);
		registerSdkIdentifiers(this.fullId, { tableName: `mock-${this.fullId}`.substring(0, 255) });
		this.filePath = join(getMockDataDir(this), 'counters.json');
		this.data = this.loadFromDisk();
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
		// Synchronous from here to the write: no other request can interleave
		// in this process, so the check-and-add is atomic like the AWS update.
		const current = this.data.get(key);
		if (current === undefined) {
			if (options?.ifExists) throw missingCounter();
			if (!plan.createOk) throw incrementOutOfBounds(this.bounds, delta, 0);
		} else if (!allows(plan, current)) {
			throw incrementOutOfBounds(this.bounds, delta, current);
		}
		const next = (current ?? 0) + delta;
		this.data.set(key, next);
		this.flushToDisk();
		return next;
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
		return this.data.get(key) ?? 0;
	}

	/**
	 * Read many counters at once. Missing counters read as `0`.
	 *
	 * @param keys - The counters' keys. Any length; requests are chunked.
	 * @returns The values, in the same order as `keys`.
	 */
	async getBatch(keys: string[]): Promise<number[]> {
		for (const key of keys) assertKey(key);
		return keys.map((key) => this.data.get(key) ?? 0);
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
		this.data.set(key, value);
		this.flushToDisk();
	}

	/**
	 * Delete a counter. It reads as `0` afterwards. Deleting a missing counter
	 * is a no-op.
	 *
	 * @param key - The counter's key.
	 */
	async delete(key: string): Promise<void> {
		assertKey(key);
		if (this.data.delete(key)) this.flushToDisk();
	}

	// ── Disk persistence ──────────────────────────────────────────────────

	private loadFromDisk(): Map<string, number> {
		if (!existsSync(this.filePath)) return new Map();
		try {
			const obj = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
			const entries = new Map<string, number>();
			for (const [key, value] of Object.entries(obj)) {
				if (typeof value === 'number' && Number.isSafeInteger(value)) entries.set(key, value);
			}
			return entries;
		} catch {
			return new Map();
		}
	}

	private flushToDisk(): void {
		writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.data), null, 2));
	}
}
