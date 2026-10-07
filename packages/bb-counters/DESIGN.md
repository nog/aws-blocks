# Counters — Design

## Data model

One DynamoDB table per block, partition key `pk` (string) and one numeric attribute `value`. Each key is an independent counter. The schema is fixed by the block, so no item can ever fail to match it — a counter is always "a key and a safe integer".

A key that does not exist reads as `0`. There is no "missing" state distinct from zero; `delete` returns a counter to `0`.

## Increment (AWS)

`increment(key, delta)` is a single `UpdateItem`:

```
UpdateExpression:     ADD #v :d
ConditionExpression:  (attribute_not_exists(#v) OR #v BETWEEN :lo AND :hi)    -- when 0 + delta is in range
                      #v BETWEEN :lo AND :hi                                    -- otherwise
                      prefixed with  attribute_exists(#pk) AND ...              -- when { ifExists: true }
ReturnValues:         UPDATED_NEW
ReturnValuesOnConditionCheckFailure: ALL_OLD
```

- **No arithmetic in conditions.** DynamoDB condition expressions cannot add, and they evaluate against the value *before* the update. The bounds check `value + delta ∈ [min, max]` is therefore rewritten as `value ∈ [min - delta, max - delta]`, with `lo` / `hi` computed client-side.
- **`lo` / `hi` are `bigint`.** With the default bounds (`±Number.MAX_SAFE_INTEGER`) any non-zero delta pushes one of them outside the safe-integer range, and `lib-dynamodb` refuses to marshal such a `number`. `bigint` marshals as a DynamoDB number exactly.
- **Creation from 0.** `ADD` on a missing item creates it with `value = delta`, but `BETWEEN` on a missing attribute evaluates to false. Creation is therefore allowed explicitly with `attribute_not_exists(#v)` — and only when `0 + delta` is itself in range, which is decided client-side before sending.
- **Safe-integer clamp.** Even without `min` / `max`, the range is `[MIN_SAFE_INTEGER, MAX_SAFE_INTEGER]`. Past `2^53`, `lib-dynamodb` (with the default `DynamoDBDocumentClient` settings used here) returns a `bigint` instead of a `number`, which would silently break `Promise<number>`. The clamp makes that state unreachable through the block.
- **Failure diagnosis.** DynamoDB reports every failed condition as one `ConditionalCheckFailedException`. `ALL_OLD` returns the item as it was: no item + `ifExists` → `ConditionalCheckFailed`; otherwise → `OutOfBounds`, with the current value (or `0`) in the message. No extra read is needed.
- **No retries.** Concurrent increments are serialized by DynamoDB on the item. There is no optimistic-locking loop to back off from, so throughput on one key is bounded by the partition, not by contention.

`set` is a `PutItem` (bounds validated client-side), `delete` a `DeleteItem`. `get` and `getBatch` use strongly consistent reads, so a read after a completed increment always sees it. `getBatch` de-duplicates keys, chunks at the 100-key `BatchGetItem` limit, and retries `UnprocessedKeys` with jittered exponential backoff.

## Infrastructure (CDK)

`index.cdk.ts` provisions an on-demand table named `fullId.substring(0, 255)` (the runtime derives the same name), AWS-managed encryption, and resolves `removalPolicy` / `deletionProtection` / `pointInTimeRecovery` from the per-block options or the stack `defaults`, exactly like `bb-kv-store`. The shared execution role gets read/write data access. Invalid `min` / `max` fail the synth. Every runtime method is stubbed with `synthGuard`.

## Mock implementation

`index.mock.ts` keeps counters in a `Map` and writes `.bb-data/{fullId}/counters.json` after every mutation. The check-and-add in `increment` is synchronous (no `await` between reading the current value and writing the new one), so it is atomic within the process, matching DynamoDB's per-item serialization. Bounds and error construction live in `bounds.ts`, shared by both runtimes, so the two produce identical error names, statuses, and messages for identical inputs.

### Mock vs AWS behavior differences

- **Atomicity scope.** The mock is atomic within one Node process. Two dev-server processes sharing one `.bb-data` directory can lose updates; AWS cannot.
- **Throughput.** The mock has no per-key write limit. On AWS a single key is limited by one partition (on the order of 1,000 writes/second) and may be throttled beyond it.
- **Failed writes cost.** On AWS a rejected increment (out of bounds, `ifExists`) still consumes write capacity; the mock has no notion of capacity.

Parity of request shapes and error mapping is covered by `parity.test.ts`; the DynamoDB semantics it stands in for are exercised end to end by `test-apps/comprehensive/test/counters.test.ts` against a sandbox.

## Out of scope (possible follow-ups)

- **Hot-key sharding** (e.g. a `shards: N` option that spreads one logical counter over N items and sums on read).
- **Per-call bounds** overriding the block-level `min` / `max`.
- `fromExisting()` / customer-managed KMS keys, which `bb-kv-store` supports.
