---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
---

Durable events. Every event is written to a new `events` table in the transaction whose writes it describes, and a
relay delivers it after commit; a process killed between commit and delivery delivers on the next start. A failed
delivery stays queued and is retried (up to five attempts) without failing the command that published it. Handler
idempotency records live in the command store (`processed_events`), so a restart no longer forgets them, and warm-up
rebuilds projections and search through the new `EventBusAdapter.replay` (subscriptions marked `derived`) instead of
re-publishing to every subscriber, so restarting no longer re-sends order confirmations and welcome emails. Delivered
events and idempotency records older than 30 days are removed by a retention sweeper. `createEventPublisher` now
requires `store`, `eventLog` and `relay` (`createRelay`). The in-memory document store treats a partition value of
`'*'` as a full scan, which the cart-abandonment sweeper relies on.
