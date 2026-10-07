---
"@aws-blocks/bb-counters": minor
"@aws-blocks/blocks": patch
---

Add the `Counters` Building Block (`@aws-blocks/bb-counters`), re-exported from `@aws-blocks/blocks`: many named integer counters with atomic, retry-free `increment` / `decrement` backed by a single DynamoDB `UpdateItem ADD`. Optional block-level `min` / `max` bounds are enforced by DynamoDB itself, so a counter never holds an out-of-range value even under concurrency; out-of-range operations throw `CountersErrors.OutOfBounds` (HTTP 409) without writing. Also provides `get` / `getBatch` (missing counters read as `0`), `set`, `delete`, and `{ ifExists: true }` for explicit creation.
