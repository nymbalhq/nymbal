---
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'@nymbalhq/doc-store-redis': minor
'@nymbalhq/doc-store-postgres-jsonb': minor
'@nymbalhq/event-bus-redis-streams': minor
'nymbal': patch
'create-nymbal-app': minor
---

A store picks its read model and its event bus from what is built. `infrastructure.documentStore` is `in-memory`,
`redis` or `postgres-jsonb`; `infrastructure.eventBus` is `in-process` or `redis-streams`. Each non-native choice is its
own package, which the kernel imports only when the config names it: `@nymbalhq/doc-store-redis` (with `ioredis`),
`@nymbalhq/doc-store-postgres-jsonb` (with `pg`) and `@nymbalhq/event-bus-redis-streams` (with `ioredis`). A missing
package fails `createApp` with `adapter.package_missing` and the install line, as the provider adapters do.

- The Redis store and bus share an optional `infrastructure.redis` block: `url` (default `REDIS_URL`), `prefix`
  (default `NYMBAL_REDIS_PREFIX`, then `nymbal`; it namespaces every key and stream), and the bus's `ackTimeoutMs`
  (15 000), `claimIdleMs` (5 000) and `streamMaxLen` (10 000). A Redis store or bus with no URL fails at `createApp`.
- `postgres-jsonb` needs `commandStore: 'postgres'` and uses its connection (`DATABASE_URL`). It creates and owns one
  table, `nymbal_documents`, at start.
- `redis-streams` needs a shared document store (`redis` or `postgres-jsonb`): a named subscription is one consumer
  group across instances, so an in-memory read model would miss the events another instance handled.
- On every bus, `publish` resolves only after every matching handler has finished, so a read straight after a command
  sees its projection. Delivery is at least once, so handlers must be idempotent. A subscription with a `name` is
  handled once per name across instances; one without is handled by every subscriber on every instance (the admin's
  live stream now subscribes without a name, so every open tab gets every event).
- `infrastructure.media` is new, with one value, `local-fs` (the default). `app.platform.media` is the instance, and
  `app.capabilities().media` reports its own `capabilities()`.

**Breaking: the infrastructure config lists only what is built.**

- `infrastructure.cloud` and `infrastructure.compute` are removed: they drove nothing. A config that still sets either
  fails `loadConfig` saying the key was removed and should be deleted. Delete both lines.
- `documentStore: 'dynamodb' | 'firestore' | 'cosmosdb'` and `eventBus: 'eventbridge' | 'pubsub' | 'service-bus'`, which
  only threw "planned for v1.0" at start, are removed. Any value a slot does not list, and any key `infrastructure` does
  not know, now fails `loadConfig` naming the slot's values or the known keys (`KNOWN_INFRASTRUCTURE`, exported by
  `@nymbalhq/config`).
- The refusal of `security.adapter: 'middleware'` on `cloud: aws | gcp | azure` went with `cloud`.

**Breaking for code that builds the platform itself.** `createPlatform(config, options)` takes the primitives as
instances: `{ documentStore, eventBus, media }` beside `sqlitePath`, `postgresUrl` and `logger`. `resolvePrimitives(config)`
builds them from the config, and `createApp` does both. `createDocumentStore` and `createEventBus` are gone.
`MediaStorage` now lives in `@nymbalhq/types` (`@nymbalhq/platform` still re-exports it). `@nymbalhq/types` adds
`compareDocumentValues`, `matchesSortKey` and `queryDocuments`, the order and filter every document store is held to:
values of different types rank by type (numbers, strings, other types, then null and missing), so `1` and `'1'` no
longer compare as equal both ways, and nulls sort last in either direction. A `query` cursor now seeks by position
without an `orderBy` too, so a document deleted between pages no longer restarts the walk. `AdapterContext.slot` is a
`Slot`: the commerce slots plus `documentStore`, `eventBus` and `media`.
