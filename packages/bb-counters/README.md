# Counters

Many named integer counters with atomic, retry-free increments and min/max bounds, backed by DynamoDB.

**Keywords:** counter, increment, decrement, atomic, likes, views, stock, inventory, quota, rate limit, DynamoDB

**When to use:** Many concurrent writers add to a number — likes or view counts per item, stock levels, usage quotas, rate-limit buckets. Each `increment` is one atomic DynamoDB update: no read-modify-write loop, no optimistic-locking retries, no lost updates.

**When NOT to use:** Gap-free sequential IDs (a request that fails after its increment leaves a gap). A single counter written more than ~1,000 times per second (one key lives on one DynamoDB partition; this block does not shard hot keys). Arbitrary numeric fields on your own records — keep the count in `Counters` and join it at read time (see [Counting things you store elsewhere](#counting-things-you-store-elsewhere)).

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const counters = new Counters(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `increment(key, delta = 1, options?)` | `Promise<number>` | Atomically add `delta` (negative subtracts) and return the new value. A missing counter starts from `0`. |
| `decrement(key, delta = 1, options?)` | `Promise<number>` | Same as `increment(key, -delta, options)`. |
| `get(key)` | `Promise<number>` | Read a counter. A counter that was never written reads as `0`. Strongly consistent. |
| `getBatch(keys)` | `Promise<number[]>` | Read many counters, in the order of `keys`. Missing counters read as `0`. Any length (chunked into 100-key requests). |
| `set(key, value)` | `Promise<void>` | Overwrite a counter, e.g. reset it to `0`. |
| `delete(key)` | `Promise<void>` | Remove a counter; it reads as `0` afterwards. |

**Runtime only.** Data methods run at request time — call them inside an `ApiNamespace` method, `RawRoute` handler, or job handler, **not** at the top level of your `aws-blocks/index.ts` (top-level code runs during CDK synth, where the methods throw).

Counters hold **safe integers** only (`Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER`). `delta` and `value` must be safe integers too; anything else throws `ValidationFailedException`.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `min` | `number` | Lowest value a counter may hold. Defaults to `Number.MIN_SAFE_INTEGER`. |
| `max` | `number` | Highest value a counter may hold. Defaults to `Number.MAX_SAFE_INTEGER`. |
| `removalPolicy` | `'destroy' \| 'retain'` | Removal behavior for the underlying DynamoDB table. When omitted, the stack-wide `defaults` apply (`production` retains, `sandbox` destroys). Ignored by the mock and browser runtimes. |
| `deletionProtection` | `boolean` | Block deletion of the table via any API. When omitted, the stack-wide `defaults` apply. Ignored by the mock and browser runtimes. |
| `pointInTimeRecovery` | `boolean \| { retentionDays: number }` | DynamoDB Point-in-Time Recovery. When omitted, the stack-wide `defaults` apply (on under `production`, off under `sandbox`). Ignored by the mock and browser runtimes. |

`increment` and `decrement` accept `{ ifExists: true }` to refuse creating a missing counter (see below).

## Bounds

`min` / `max` apply to every counter in the block. An operation that would move a counter outside `[min, max]` is rejected **without writing**, so a counter never holds an out-of-range value — even under concurrency.

```typescript
import { Counters, CountersErrors } from '@aws-blocks/blocks';
import { isBlocksError } from '@aws-blocks/core';

const stock = new Counters(scope, 'stock', { min: 0 });

export const api = new ApiNamespace(scope, 'api', () => ({
  async restock(sku: string, amount: number) {
    return await stock.increment(sku, amount);
  },
  async buy(sku: string) {
    try {
      return { remaining: await stock.decrement(sku) };
    } catch (e: unknown) {
      if (isBlocksError(e, CountersErrors.OutOfBounds)) return { soldOut: true };
      throw e;
    }
  },
}));
```

A missing counter reads as `0`, but it is only created when `0 + delta` is itself in range — with `{ min: 0 }`, `decrement` on a never-written key is rejected rather than creating `-1`.

## Explicit creation with `ifExists`

By default a missing counter is created by its first `increment`. Pass `{ ifExists: true }` to require that it was created first (with `set`, or an earlier increment):

```typescript
await votes.set(`poll:${pollId}:yes`, 0);                          // open the poll
await votes.increment(`poll:${pollId}:yes`, 1, { ifExists: true }); // ok
await votes.increment('poll:typo:yes', 1, { ifExists: true });       // throws ConditionalCheckFailedException
```

## Counting things you store elsewhere

Keep the count out of the record it counts and read both together. Entity writes and counter writes then never contend, and each increment costs one write capacity unit regardless of how large the record is.

```typescript
const posts = new DistributedTable(scope, 'posts', { schema: postSchema, key: { partitionKey: 'id' } });
const likes = new Counters(scope, 'likes', { min: 0 });

export const api = new ApiNamespace(scope, 'api', () => ({
  async like(postId: string) {
    return await likes.increment(postId);
  },
  async listPosts(ids: string[]) {
    const [items, counts] = await Promise.all([posts.getBatch(ids.map((id) => ({ id }))), likes.getBatch(ids)]);
    return items.map((post, i) => post && { ...post, likes: counts[i] });
  },
}));
```

## Errors

| Error (`CountersErrors.*`) | HTTP | When |
|---|---|---|
| `OutOfBounds` (`CounterOutOfBoundsException`) | 409 | The operation would leave `[min, max]`. Nothing was written. The message includes the current value and the range. Not retriable. |
| `ConditionalCheckFailed` (`ConditionalCheckFailedException`) | 409 | `{ ifExists: true }` on a missing counter. Not retriable. |
| `ValidationFailed` (`ValidationFailedException`) | — | Empty key, a non-integer / unsafe `delta` or `value`, or `min > max` at construction. |

Match them with `isBlocksError(e, CountersErrors.OutOfBounds)` — this works on the server and in the browser.

## Scaling

PAY_PER_REQUEST billing. Each `increment` / `decrement` / `set` / `delete` is one write; `get` is one strongly consistent read. Throughput scales with the number of distinct keys; a single key is limited by one DynamoDB partition (on the order of 1,000 writes per second). Rejected operations (out of bounds, `ifExists`) still consume a write.

## Local Development

`npm run dev` runs the mock entry — no AWS account required. Counters persist under `.bb-data/{fullId}/counters.json`; wipe local state with `rm -rf .bb-data`.
