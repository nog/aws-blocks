// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, synthGuard } from '@aws-blocks/core/cdk';
import { Annotations, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { CountersOptions } from './types.js';

// ── Public types + errors ────────────────────────────────────────────────────
export { CountersErrors } from './errors.js';
export type { CountersOptions, IncrementOptions } from './types.js';

/**
 * The `cdk` export: provisions one on-demand DynamoDB table (partition key
 * `pk`, value attribute `value`) and grants the shared execution role
 * read/write access. The runtime derives the same table name from `fullId`.
 */
export class Counters extends BuildingBlockScope {
	readonly table: Table;

	constructor(scope: ScopeParent, id: string, options?: CountersOptions) {
		super(id, { parent: scope, vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] } });

		// Fail the synth on bounds the runtime would reject at cold start.
		const min = options?.min ?? Number.MIN_SAFE_INTEGER;
		const max = options?.max ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
			throw new Error(
				`Counters '${id}': min and max must be safe integers with min <= max (got min=${String(min)}, max=${String(max)})`,
			);
		}

		const removalPolicy =
			options?.removalPolicy === 'destroy'
				? RemovalPolicy.DESTROY
				: options?.removalPolicy === 'retain'
					? RemovalPolicy.RETAIN
					: this.defaults.removalPolicy;

		const pitrSetting = options?.pointInTimeRecovery ?? this.defaults.pointInTimeRecovery;
		let pitrEnabled: boolean;
		let pitrDays: number | undefined;
		if (typeof pitrSetting === 'object' && pitrSetting !== null) {
			pitrEnabled = true;
			pitrDays = pitrSetting.retentionDays;
			if (!Number.isInteger(pitrDays) || pitrDays < 1 || pitrDays > 35) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-counters:InvalidPitrDays',
					`pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(pitrDays)}) — ` +
						`falling back to the 35-day default.`,
				);
				pitrDays = undefined;
			}
		} else {
			pitrEnabled = pitrSetting === true;
			pitrDays = undefined;
		}

		this.table = new Table(this, 'table', {
			tableName: this.fullId.substring(0, 255),
			partitionKey: { name: 'pk', type: AttributeType.STRING },
			billingMode: BillingMode.PAY_PER_REQUEST,
			removalPolicy,
			deletionProtection: options?.deletionProtection ?? this.defaults.deletionProtection,
			pointInTimeRecoverySpecification: pitrEnabled
				? {
						pointInTimeRecoveryEnabled: true,
						...(pitrDays !== undefined ? { recoveryPeriodInDays: pitrDays } : {}),
					}
				: undefined,
			encryption: TableEncryption.AWS_MANAGED,
		});

		this.table.grantReadWriteData(this.executionRole);
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	increment(..._args: unknown[]): never {
		return synthGuard('Counters', 'increment');
	}
	decrement(..._args: unknown[]): never {
		return synthGuard('Counters', 'decrement');
	}
	get(..._args: unknown[]): never {
		return synthGuard('Counters', 'get');
	}
	getBatch(..._args: unknown[]): never {
		return synthGuard('Counters', 'getBatch');
	}
	set(..._args: unknown[]): never {
		return synthGuard('Counters', 'set');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('Counters', 'delete');
	}
}
