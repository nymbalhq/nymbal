---
'@nymbalhq/platform': minor
---

Real command-store transactions on SQLite and Postgres. `CommandStore` now exposes `read` and `transaction` (which joins
an open transaction in the same call chain); repository reads take a `ReadTx` and writes a `Tx`, and `rawClients` is
the way to the Drizzle clients for migrations, seeding and tests. Stock moves by conditional updates
(`decrementStock`/`incrementStock`), so concurrent checkouts no longer oversell; events published inside a transaction
are delivered after it commits and dropped on rollback; `finalize` finds its order by payment intent through a new
index; the reservation sweeper returns the stock of expired reservations and exposes `tick()`.
