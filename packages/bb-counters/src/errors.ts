// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Counters. Match them in catch blocks with
 * `isBlocksError(e, CountersErrors.Foo)` from `@aws-blocks/core` — errors
 * cross the wire by `name`, so the same guard works server- and client-side.
 *
 * @example
 * ```typescript
 * try {
 *   await stock.decrement('sku-1');
 * } catch (e: unknown) {
 *   if (isBlocksError(e, CountersErrors.OutOfBounds)) {
 *     // sold out
 *   }
 *   throw e;
 * }
 * ```
 */
export const CountersErrors = {
	/**
	 * `increment` / `decrement` was called with `{ ifExists: true }` and the
	 * counter does not exist. Serializes to HTTP 409 (Conflict), not retriable.
	 */
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	/**
	 * The operation would move the counter outside the block's `[min, max]`
	 * range (or outside the safe-integer range when no bounds are set). Nothing
	 * was written. Serializes to HTTP 409 (Conflict), not retriable: a blind
	 * retry fails identically until something else moves the counter.
	 */
	OutOfBounds: 'CounterOutOfBoundsException',
	/**
	 * An argument or option is invalid: a non-integer or unsafe-integer
	 * `delta` / value / bound, or `min` greater than `max`.
	 */
	ValidationFailed: 'ValidationFailedException',
} as const;
