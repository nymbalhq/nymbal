# @nymbalhq/doc-store-redis

## 1.2.0

### Minor Changes

- 1653d3f: A third party can certify their own adapter: `npm install --save-dev @nymbalhq/contract-tests vitest`, name the
  package on its slot (`commerce.search: { provider: 'custom', package: '@acme/nymbal-search', config: {...} }`) and run
  `nymbal test:contracts --package @acme/nymbal-search`. It builds the adapter with the package's
  `createAdapter(<the slot's config>)` and runs the published suite for its kind with the project's own vitest. It
  prints `certified <pkg> (<kind>): N cases passed` and exits 0 only when every case passed, else
  `not certified <pkg> (<kind>): F of N cases failed` and exits 1.
  - `@nymbalhq/contract-tests` publishes with the group. Every `run<Kind>Contract(name, build, options?)` runs the
    same cases Nymbal's own adapters pass: the document store's reference-model property, the event bus's delivery
    contract and search's pagination, ranking, facet and hostile-input properties are part of it now; reviews gain a
    cursor-walk case and payments a refund idempotency case (and, with `signedWebhook`, a webhook parsed twice). Every
    suite checks that `healthCheck()` resolves `healthy` or `degraded` within 6 s, which a primitive must implement to
    certify. With `unreachable` (an adapter whose dependency is gone) it checks that `healthCheck()` reports `down` and
    one representative operation rejects, each within 6 s. `runMediaStorageContract` takes `{ fetchUrl }` as options.
    `contractSuites` maps each kind to its suite, and the search oracle (`searchTerms`, `matchesQuery`,
    `toSearchDocument`) is exported.
  - A package may export `contractOptions: { options?, unreachable?, kind? }`: the options when no slot names it, the
    options of an unreachable adapter, and a primitive's kind (`documentStore`, `eventBus` or `media`). Both go to
    `createAdapter` and then to `initialize` when the adapter has one, as the slot's config does. A slot config holding
    a value JSON cannot carry (a function, a Date, a BigInt) is refused with one line. `--slot` picks the slot when
    several name the package. `--adapter` runs the monorepo's own contract files, as before.
  - Every commerce slot block takes an optional `package`, an npm package name. The kernel does not read it.
  - Native reviews page by cursor: `getProductReviews(productId, { limit, cursor })` returns a `nextCursor` until the
    last page, newest first. The native payments stub answers a refund repeated under one `idempotencyKey` with the
    first refund and refunds once. adapter-smtp's `healthCheck` reports `down` when the server cannot be reached
    (`degraded` stays for a server that refuses the login), within 5 s, and a send gives up after 4 s on a host that
    does not connect, greet or answer, where nodemailer waited up to two minutes.
  - The Redis document store's client and the Redis Streams bus's command client no longer queue a command until the
    server returns: on a dead server it rejects within a few seconds, and the client keeps reconnecting, so commands
    succeed again once the server is back.

- 7a4e472: Every derived read model can be rebuilt from the command store's tables, completely and without readers seeing it
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

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0

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

- 421722f: `nymbal add <recipe>` puts a scaffolded store on a service in one command: `redis`, `postgres`, `s3` or `stripe`. It
  installs the packages with the project's package manager, writes the slot values into `nymbal.config.ts`, appends the
  variables the service reads to `.env.example`, checks the result loads, and prints what is left to do (each required
  variable still unset is listed as `set NAME in .env`).
  - The edit goes through the config's AST, so comments, order and every other key stay as they were. Secrets are written
    only as `env('NAME')` calls, and `env` is added to the `@nymbalhq/config` import when needed. The edited config is
    loaded before it is written, with the values in `.env` applied as `nymbal dev` applies them and a placeholder for
    every variable still unset that an `env()` call with no default names. A secret not yet set never blocks an add, and
    a default or a `.env` value is validated as it will run. Nothing connects to the service.
  - Re-running a recipe is a no-op. A value the developer chose (not the scaffold's default) is a conflict that changes
    nothing and names the path and both values; `--force` overwrites it. `--dry-run` prints the config change, the
    `.env.example` lines and the install line. `--no-install` fails with the install line when a package is missing.
  - Each recipe is data in the package it belongs to, `recipes/<name>.json` in the `Recipe` shape that `@nymbalhq/types`
    now exports: `@nymbalhq/doc-store-redis` ships `redis`, `@nymbalhq/media-s3` ships `s3`, `@nymbalhq/adapter-stripe`
    ships `stripe` and `@nymbalhq/platform` ships `postgres`. Each exports `./recipes/*`.
  - `@nymbalhq/platform` exports `installLine(packages, env, cwd)`, the install command the adapter loader names for a
    missing package.

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
