// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for Counters. Imported by the mock, aws, cdk, and browser
 * entry points. Types only — this file has zero runtime dependencies.
 */

/** Options for constructing a {@link Counters}. */
export interface CountersOptions {
	/**
	 * Lowest value any counter in this block may hold. An `increment` /
	 * `decrement` / `set` that would move a counter below it is rejected
	 * without writing, with `CountersErrors.OutOfBounds`.
	 *
	 * Must be a safe integer. Defaults to `Number.MIN_SAFE_INTEGER`.
	 *
	 * @example
	 * ```typescript
	 * // Stock can never go negative
	 * const stock = new Counters(scope, 'stock', { min: 0 });
	 * ```
	 */
	min?: number;
	/**
	 * Highest value any counter in this block may hold. An `increment` /
	 * `decrement` / `set` that would move a counter above it is rejected
	 * without writing, with `CountersErrors.OutOfBounds`.
	 *
	 * Must be a safe integer. Defaults to `Number.MAX_SAFE_INTEGER`.
	 *
	 * @example
	 * ```typescript
	 * // At most 100 calls per user per day
	 * const quota = new Counters(scope, 'daily-quota', { min: 0, max: 100 });
	 * ```
	 */
	max?: number;
	/**
	 * Removal behavior (via CDK/CloudFormation) for the underlying DynamoDB
	 * table. When omitted, the stack-wide `defaults` apply (`production` retains
	 * data on `cdk destroy`, `sandbox` destroys it). Pass `'destroy'` or
	 * `'retain'` to override for this one block.
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to retain).
	 */
	removalPolicy?: 'destroy' | 'retain';
	/**
	 * Whether to block deletion of the underlying DynamoDB table. Unlike
	 * `removalPolicy` (which only governs CDK/CloudFormation), deletion
	 * protection also prevents deletion via the CLI, API, and AWS console.
	 * When omitted, the stack-wide `defaults` apply (on in `production`, off in
	 * `sandbox`).
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to protect).
	 */
	deletionProtection?: boolean;
	/**
	 * DynamoDB Point-in-Time Recovery (continuous backups).
	 *
	 * - `true` — enable PITR with the default 35-day window.
	 * - `false` — disable PITR.
	 * - `{ retentionDays: n }` — enable PITR and keep `n` days (**1–35**).
	 *
	 * When omitted, the stack-wide default applies (`defaults.pointInTimeRecovery`
	 * — on under `production`, off under `sandbox`).
	 *
	 * Ignored by the mock and browser runtimes (no AWS resource to back up).
	 */
	pointInTimeRecovery?: boolean | { retentionDays: number };
}

/** Options accepted by `increment` and `decrement`. */
export interface IncrementOptions {
	/**
	 * Only update a counter that already exists (was created by an earlier
	 * `increment`, `decrement`, or `set`). Without it, a missing counter starts
	 * from `0`. When the counter is missing, throws
	 * `CountersErrors.ConditionalCheckFailed` and writes nothing.
	 *
	 * @example
	 * ```typescript
	 * await counters.set('post#1', 0);                          // explicit creation
	 * await counters.increment('post#1', 1, { ifExists: true }); // ok
	 * await counters.increment('post#2', 1, { ifExists: true }); // throws
	 * ```
	 */
	ifExists?: boolean;
}
