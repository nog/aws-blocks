// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { Counters } from './index.cdk.js';

// Minimal BlocksStack-shaped parent (shared execution role + handler + defaults),
// mirroring bb-kv-store's CDK tests.
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function setup(defaults: BlocksDefaults = BlocksPresets.production): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	stack.defaults = defaults;
	return { stack, parent: new Scope('app') };
}

test('CDK: provisions one on-demand table keyed by pk', () => {
	const { stack, parent } = setup();
	new Counters(parent, 'likes');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 1);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		BillingMode: 'PAY_PER_REQUEST',
		KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
		AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
	});
});

test('CDK: grants the execution role UpdateItem on the table', () => {
	const { stack, parent } = setup();
	new Counters(parent, 'likes');
	Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({ Action: Match.arrayWith(['dynamodb:BatchGetItem', 'dynamodb:UpdateItem']) }),
			]),
		},
	});
});

test('CDK: production defaults retain the table and enable PITR + deletion protection', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new Counters(parent, 'likes');
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: true,
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
	});
});

test('CDK: per-block options override the stack defaults', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new Counters(parent, 'likes', {
		removalPolicy: 'destroy',
		deletionProtection: false,
		pointInTimeRecovery: { retentionDays: 7 },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: false,
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
	});
});

test('CDK: invalid bounds fail the synth', () => {
	const { parent } = setup();
	assert.throws(() => new Counters(parent, 'bad', { min: 1, max: 0 }), /min <= max/);
	assert.throws(() => new Counters(parent, 'frac', { max: 1.5 }), /safe integers/);
});

test('CDK: runtime methods throw an actionable error at synth', () => {
	const { parent } = setup();
	const counters = new Counters(parent, 'likes');
	for (const call of [
		() => counters.increment('k'),
		() => counters.decrement('k'),
		() => counters.get('k'),
		() => counters.getBatch(['k']),
		() => counters.set('k', 0),
		() => counters.delete('k'),
	]) {
		assert.throws(call);
	}
});
