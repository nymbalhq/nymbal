---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/doc-store-redis': minor
'@nymbalhq/doc-store-postgres-jsonb': minor
'@nymbalhq/contract-tests': minor
'nymbal': minor
---

Every derived read model can be rebuilt from the command store's tables, completely and without readers seeing it
half-built, and a fresh process serves exactly what a long-running one serves.

- **`nymbal replay --to <catalogue|orders|customers|search|all>`.** Rebuilds the read model from the tables, swaps it
  in, then re-applies the events delivered while it was read. It prints each model with the documents in each
  collection, and exits 2 when a rebuilder fails (nothing is swapped) or a catch-up event fails (the model is swapped,
  and the event's seq is printed). `--dry-run` rebuilds into memory, prints what would be added, changed and removed,
  writes nothing, and exits 1 if anything differs. On an `in-memory` document store the document models live in the
  server's process, so only `--to search` runs: use `redis` or `postgres-jsonb` for a shared read model.
- **Boot rebuilds.** `createApp` rebuilds every read model before it serves, in place of the old warm-up, which
  replayed only created and placed events (statuses, stock and updates were lost on a restart). `warmDocumentStore` is
  removed; `rebuild`, `diffReadModel`, `READ_MODELS` and `openReadModels` are exported. Seed calls the same rebuild.
- **The live projections match a rebuild.** They build every document from the rows at handle time, through the same
  builders a rebuild uses: a recategorised product leaves no stale `products-by-category` entry, a stock change and a
  category rename or delete re-project the products concerned, a paid or refunded order updates its customer's
  profile, and a pending order's document carries its payment intent.
- **Events.** `OrderService.updateStatus` publishes `order.status_changed.v1` (`orderId`, `from`, `to`), and a
  checkout publishes `payment.intent_created.v1` (`paymentId`, `orderId`) when it stores the intent on the order.
- **Adapters.** `DocumentStoreAdapter` gains `replaceCollection(collection, entries)`: readers see the old contents
  or the new, and a source that throws leaves the old. The Redis store stages a hash and `RENAME`s it with its expiry
  index; Postgres JSONB replaces in one transaction. `SearchAdapter` gains an optional `replaceAll(documents)`, which
  the native index implements. The document store contract suite in `@nymbalhq/contract-tests` has
  `replaceCollection` cases, so a third-party store must implement it.
- **Migration `0010`** indexes `events (dead_at, delivered_at, seq)` for the catch-up read. Run `nymbal migrate`.
