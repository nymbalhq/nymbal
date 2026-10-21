# @nymbalhq/event-bus-redis-streams

## 1.1.0

### Minor Changes

- 3b028c0: `nymbal dev` starts quietly and says what is running, and `nymbal doctor` checks a project without changing it.
  - `nymbal dev` logs at `info`: warnings, errors and notable events, not every projection. `--verbose` logs at debug,
    and `LOG_LEVEL`, when set, wins over the flag. Once the API is up (and the storefront started), it prints one
    summary: the store, the API, storefront and admin URLs, the command store, each commerce slot's provider and
    capabilities, and each primitive's provider. A Postgres URL is shown as `scheme://host:port/db`, never with its
    credentials. `event handlers registered`, `Warmed document store` and `HTTP server listening` now log at debug.
  - `nymbal doctor [--json] [--timeout <ms>]` prints one line per check, `<ok|warn|down>  <name>  <detail>`: `config`,
    `package <slot>` for each provider that lives in its own package, `command store`, `migrations`, `slot <name>` for
    each commerce slot and `primitive <name>` for the document store, event bus and media. It exits 1 when any check is
    `down`, naming what and why; `warn` alone exits 0. `--json` prints `{ checks: [{ name, status, detail }] }`. It never
    migrates, seeds, writes a document, publishes, uploads or charges: SQLite is opened read-only and Postgres in
    read-only transactions, and no primitive is initialized. It never prints a secret from the config or the
    environment.
  - `diagnose(config, { adapters?, logger?, timeoutMs? })` from `@nymbalhq/platform` is what doctor runs.
  - `DocumentStoreAdapter`, `EventBusAdapter` and `MediaStorage` gain an optional `healthCheck?(): Promise<HealthReport>`,
    so a primitive written against the earlier interface still type-checks; doctor reports one without it as
    `no healthCheck`. Every bundled primitive implements it, bounded at 5 s: Redis and Redis Streams `PING`, Postgres
    JSONB a read (and `degraded` until its table exists), S3 `HeadBucket`, local-fs the root's write permission (never a
    write). `@nymbalhq/types` adds `HEALTH_CHECK_TIMEOUT_MS`, `boundedHealthCheck`, `connectionSecrets`, `displayUrl`,
    `errorText` and `SECRET_MIN_LENGTH` for implementing one.
  - `createCommandStore` takes `readOnly: true` to open the store without changing it.

- 9136ecd: A store picks its read model and its event bus from what is built. `infrastructure.documentStore` is `in-memory`,
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

### Patch Changes

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [ea74a39]
  - @nymbalhq/types@1.1.0
