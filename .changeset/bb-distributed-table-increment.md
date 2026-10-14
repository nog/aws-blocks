---
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/blocks": minor
---

feat(bb-distributed-table): add `increment()` for atomic counters

Declare numeric fields in the new `counters` option, with optional inclusive
`min` / `max` bounds, and update them with `increment(key, field, { by })`.
Each call is a single DynamoDB `UpdateItem` (`ADD`) whose condition expression
also enforces item existence and the bounds, so concurrent increments never
conflict and bounds hold under concurrency. Returns the new value.

`field` only accepts fields declared in `counters`, and `counters` only accepts
numeric, non-key schema fields, both checked at compile time. `increment()`
never creates an item (`ItemNotFound`, 404) and fails past a bound with
`CounterOutOfRange` (409, not retriable). The new `C` generic is last and
defaults to no counters, so existing code is unchanged.
