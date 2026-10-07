// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — Counters runs server-side only. Per the AWS Blocks
// convention this entry re-exports the block's public types + error constants so
// isomorphic/bundled client code type-checks; the methods live on the server
// (mock/aws) entries and are absent here.
export class Counters {
	constructor(..._args: unknown[]) {}
}
export { CountersErrors } from './errors.js';
export type { CountersOptions, IncrementOptions } from './types.js';
