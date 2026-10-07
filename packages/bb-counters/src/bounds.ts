// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounds and validation logic shared by the mock and aws-runtime entries, so
 * both layers accept, reject, and describe the same operations identically.
 * Internal — not re-exported from any entry point.
 */

import { ApiError, brandBlocksError } from '@aws-blocks/core';
import { CountersErrors } from './errors.js';
import type { CountersOptions } from './types.js';

/** The block's resolved, validated `[min, max]` range. */
export interface Bounds {
	readonly min: number;
	readonly max: number;
}

/**
 * Everything an increment needs to decide, without arithmetic in the
 * condition, whether the write stays in range.
 *
 * DynamoDB condition expressions cannot add, and they evaluate against the
 * value *before* the update. So instead of `value + delta BETWEEN min AND max`
 * we precompute `lo = min - delta` / `hi = max - delta` and require
 * `value BETWEEN lo AND hi`. `lo` / `hi` are `bigint` because they can leave
 * the safe-integer range (e.g. `MIN_SAFE_INTEGER - 1`), and `lib-dynamodb`
 * refuses to marshal such a `number`.
 */
export interface IncrementPlan {
	readonly lo: bigint;
	readonly hi: bigint;
	/** Whether a missing counter (implicit `0`) may be created by this increment, i.e. `0 + delta` is in range. */
	readonly createOk: boolean;
}

export function validationError(message: string): Error {
	const err = new Error(`${CountersErrors.ValidationFailed}: ${message}`);
	err.name = CountersErrors.ValidationFailed;
	return brandBlocksError(err);
}

function assertSafeInteger(label: string, n: unknown): asserts n is number {
	if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
		throw validationError(`${label} must be a safe integer (got ${String(n)})`);
	}
}

/** Resolve and validate the block's bounds. Throws `ValidationFailed` on bad options. */
export function resolveBounds(options?: Pick<CountersOptions, 'min' | 'max'>): Bounds {
	const min = options?.min ?? Number.MIN_SAFE_INTEGER;
	const max = options?.max ?? Number.MAX_SAFE_INTEGER;
	assertSafeInteger('min', min);
	assertSafeInteger('max', max);
	if (min > max) {
		throw validationError(`min (${min}) must be less than or equal to max (${max})`);
	}
	return { min, max };
}

/** Validate a delta and compute the range check for adding it. */
export function planIncrement(bounds: Bounds, delta: number): IncrementPlan {
	assertSafeInteger('delta', delta);
	const d = BigInt(delta);
	return {
		lo: BigInt(bounds.min) - d,
		hi: BigInt(bounds.max) - d,
		createOk: delta >= bounds.min && delta <= bounds.max,
	};
}

/** Whether `current` (a counter's value before the update) may receive the planned delta. */
export function allows(plan: IncrementPlan, current: number): boolean {
	const v = BigInt(current);
	return v >= plan.lo && v <= plan.hi;
}

/** Validate a value passed to `set`. */
export function assertSettable(bounds: Bounds, value: number): void {
	assertSafeInteger('value', value);
	if (value < bounds.min || value > bounds.max) {
		throw outOfBounds(`Value ${value} is outside the allowed range [${bounds.min}, ${bounds.max}]`);
	}
}

/** The 409 for an increment that would leave `[min, max]`. */
export function incrementOutOfBounds(bounds: Bounds, delta: number, current: number): ApiError {
	return outOfBounds(
		`Adding ${delta} to the current value ${current} would leave the allowed range [${bounds.min}, ${bounds.max}]`,
	);
}

function outOfBounds(message: string): ApiError {
	const cause = new Error(`${CountersErrors.OutOfBounds}: ${message}`);
	cause.name = CountersErrors.OutOfBounds;
	return new ApiError(message, 409, {
		name: CountersErrors.OutOfBounds,
		cause: brandBlocksError(cause),
		retriable: false,
	});
}

/** The 409 for `{ ifExists: true }` on a missing counter. */
export function missingCounter(cause?: unknown): ApiError {
	const named =
		cause ??
		brandBlocksError(
			Object.assign(new Error(`${CountersErrors.ConditionalCheckFailed}: The conditional request failed`), {
				name: CountersErrors.ConditionalCheckFailed,
			}),
		);
	return new ApiError('The counter does not exist', 409, {
		name: CountersErrors.ConditionalCheckFailed,
		cause: named,
		retriable: false,
	});
}

/** Validate a key. DynamoDB rejects empty string partition keys. */
export function assertKey(key: unknown): asserts key is string {
	if (typeof key !== 'string' || key.length === 0) {
		throw validationError('key must be a non-empty string');
	}
}
