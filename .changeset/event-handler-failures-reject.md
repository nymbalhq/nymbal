---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/event-bus-redis-streams': minor
'@nymbalhq/contract-tests': minor
---

Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
