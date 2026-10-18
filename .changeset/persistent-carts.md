---
'@nymbalhq/platform': minor
---

Persistent carts. Carts are rows in a new `carts` table in the command store (migration `0003`), so a restart keeps
every cart and any number of API processes on one database serve the same cart. Every cart command locks its row and
appends its events in the same transaction, so concurrent adds no longer lose an update. Cart expiry slides with each
write (30 days by default); an expired cart reads as missing and the abandonment sweeper deletes it. The sweeper no
longer stops at 1,000 carts and records each notice in the table, so a cart gets one `cart.abandoned` per idle period
across restarts and processes. Checkout finalisation empties the cart in the same transaction that confirms the
order, and a cart that expired before payment no longer blocks the order. `createCartService` takes `store` and
`carts` (from `buildRepositories(...).cart`) instead of `documentStore`; `createCheckoutService` and `buildServices` no
longer take `documentStore`; `startCartAbandonmentSweeper` takes `store` and `carts` plus optional `batchSize` and
`now`.
