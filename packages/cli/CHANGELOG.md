# nymbal

## 1.2.0

### Minor Changes

- 45b8128: Every change an admin, a shopper or the system makes to the store's records leaves an audit entry, and an admin write
  sent with an `Idempotency-Key` applies once, however often it is retried.
  - **Audit entries.** Migration `0011_audit_entries` adds an append-only `audit_entries` table (both dialects; its
    triggers refuse updates and deletes, and the event-retention sweep never touches it). One entry per outermost
    command, written in the command's transaction, so a rolled-back write leaves none. It names the actor (`admin:<id>`,
    `customer:<id>`, `guest:anonymous`, `system:<sweeper>`, `system:stripe-webhook`, `import:woocommerce`), the command
    (`inventory.adjust`, `order.cancel`, `checkout.place`, `product.create`, …), the records it touched by id, the
    request's correlation id and the outcome: `applied`, `refused` (its service refused it) or `replayed`. Cart commands
    and reads are not audited; a request its schema refuses leaves no entry.
  - **Idempotency.** Admin writes (`POST`, `PATCH`, `PUT`, `DELETE` under `/api/admin`) accept `Idempotency-Key`, 1-128
    characters of `[A-Za-z0-9._:-]`; any other value answers 400 naming the header. A retry with the same key and the
    same request answers the first response exactly, with `Idempotent-Replayed: true`, and runs nothing; the same key
    with a different body or path answers 409 `idempotency.key_reused`. Concurrent first attempts apply once. A refused
    command is not stored for replay: its retry runs again. Without a key, a write behaves as before.
  - **Activity.** `GET /api/admin/activity?actor&command&subject&correlation&outcome&since&until&cursor&limit` lists
    entries newest first, a page at a time (`meta.nextCursor`), with each response's status but never its body.
    `GET /api/admin/activity/export?since&until&correlation` streams them oldest first as NDJSON, ids only.
  - **Admin.** A new Activity page (`/admin/activity`) filters the trail and downloads the export. Every admin write
    sends a key per user intent: a double click within one action sends one key, and the client's own re-sends (after a
    CSRF refusal or a 401 refresh) reuse it. The stock-history drawer now shows a variant's adjustments; it was always
    empty.
  - **CLI.** `nymbal audit export [--since <t>] [--until <t>] [--correlation <id>] [--out <file>]` prints the same NDJSON,
    opening the store read-only; a bad time exits 2. `nymbal import` attributes its writes to `import:woocommerce`.
  - **CORS.** `x-correlation-id` and `Idempotent-Replayed` are in `Access-Control-Expose-Headers`.
  - **API.** `@nymbalhq/platform` exports `runAsActor`, `currentActor`, `actorOf`, `audit.note`, `auditedCommand` and
    the `audit_entries` repository; `@nymbalhq/types` adds `AuditEntry`, `AuditActor`, `AuditOutcome`, `AuditSubject`,
    `IDEMPOTENCY_KEY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER` and `isValidIdempotencyKey`. Every non-GET entry in
    `routeSchemas` declares its audit `command` (or `null`); a route without one stops startup.

- b836370: A store can put its security rules on its Cloudflare zone: `security.adapter: 'cloudflare'`. The adapter is the new
  `@nymbalhq/security-cloudflare` package (`nymbal add cloudflare`), which the kernel imports only when the config names
  it: `npm install @nymbalhq/security-cloudflare`. It talks to the Cloudflare API with `fetch`, so there is no SDK to
  install beside it.
  - `security.cloudflare` takes `zoneId` and `apiToken` (both required with the `cloudflare` adapter, read with `env()`)
    and an optional `apiBase`. New, all optional: `geo.block` (ISO 3166 alpha-2 codes), `customRules` (`name`,
    `expression`, `action`; names unique) and `managedRulesets` (`'cloudflare'`, `'owasp'`). A `middleware` store parses
    as before.
  - The zone changes only by command, never at boot: `nymbal security:plan [--json]` shows what would change,
    `security:apply` writes it, `security:drift [--json]` reports a dashboard edit (exit 1), and `security:inspect` lists
    the live rules. Exit 2 is a config, credential or API error, and every command exits 2 on a store whose adapter is
    not `cloudflare`. The token is never printed.
  - Each `rateLimit` entry becomes a rate limiting rule (`eq` for an exact path, `wildcard` for `*` and `**`), the geo
    block one custom rule, and each managed ruleset one execute rule. Every rule Nymbal writes has a `nymbal:` ref; the
    zone's own rules are kept, unchanged and first. `validate` checks the zone's plan limits over every rule in a phase,
    the zone's own included.
  - In process, the adapter sets the same response headers as `middleware`.

  **Breaking:** `security.adapter: 'aws-waf'` or `'akamai'` now fails `createApp` with a `ConfigError` naming the
  adapters that exist (`middleware, cloudflare`); before, both silently ran `middleware`. `ProviderPackage.sdk` is
  optional, and `Slot` includes `security`. `buildSecurityHeaders` is exported from `@nymbalhq/types` as well.

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

- 3591951: The event log is something an operator can read: one id follows an operation through every event it causes, the CLI
  reads the log, and old events can be archived before they are deleted.
  - **One correlation id per operation.** Every event an HTTP request publishes carries the request's correlation id,
    and every response carries it as `x-correlation-id`, Fastify's own 404 and 400 included. An inbound
    `x-correlation-id` is used only when it matches `^[A-Za-z0-9._:-]{1,128}$` (`isValidCorrelationId`); any other
    value is replaced by the request's own id. A checkout keeps its id across the payment webhook, on its failure paths
    too. Each sweeper run and each `nymbal import` run gets one id of its own, such as `sweep:cart-abandonment:<uuid>` or
    `import:woocommerce:<uuid>`. Services take no new arguments: `runWithCorrelation(id, fn)` and
    `currentCorrelationId()` carry the scope.
  - **A queryable column.** Migration `0008` adds `events.correlation_id`, indexed with `seq`, and backfills it from each
    stored envelope. Run `nymbal migrate`. The event log repository adds `queryByCorrelation`, `listAfter`, `maxSeq`,
    `listDeliveredBefore` and `deleteSeqs`, and its rows carry `createdAt`.
  - **`nymbal events`.** `nymbal events query --correlation <id>` prints one operation's events in `seq` order, and
    `nymbal events tail` follows the log live. Both take `--type 'order.*'` and `--json`, and both open the store
    read-only. Payloads are printed only with `--payload`.
  - **Retention and archive.** `events.retentionDays` (default 30) sets how long delivered events stay. With
    `events.archive: { adapter: 's3', bucket, … }`, each batch of expired events is first written as one gzip NDJSON
    object, and deleted only once the write succeeds. The archive bucket must be private: config refuses the media
    bucket. `@nymbalhq/media-s3` adds `createS3ObjectWriter` for private objects.

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

- 0fe6563: A store owner can enter the provider keys the config leaves unset in the admin's Settings page, instead of editing
  environment files. Each value is encrypted at rest, never shown again, and applied when the store next starts.
  - **Precedence.** The config wins, then the environment, then Settings. A field the config or environment sets shows
    as "Set by environment" and cannot be changed in the admin.
  - **The key.** Values are encrypted with AES-256-GCM under `NYMBAL_SECRETS_KEY` (32 random bytes, base64), each bound
    to its slot and path. `create-nymbal-app` writes a fresh key into the new project's `.env` (never `.env.example`).
    Back it up with your deploy's secrets: a store holding a saved secret refuses to start without its key, with a
    `ConfigError` naming the slot and path. A key that does not match, or a row that was changed, refuses the same way.
  - **Adapters declare their settings.** A provider package may export
    `settings: Array<{ path, label, secret, env?, optional? }>` (`AdapterSetting` in `@nymbalhq/types`). Stripe declares
    `secretKey`, `webhookSecret` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and `publishableKey`; Anthropic
    `apiKey` (`ANTHROPIC_API_KEY`) and `baseUrl`; SMTP `smtp.user` and `smtp.pass`. The kernel honours a declared `env`
    whether or not the package reads it.
  - **A missing key no longer stops the store.** When a declared secret is set nowhere, the slot gets an adapter that
    reports itself `down` (naming the field) and refuses every operation, so the store boots and the admin can take the
    key. For payments, the storefront's Place Order stays disabled. Before, Stripe without a `secretKey` stopped boot.
  - **`nymbal add stripe`** no longer writes `env('STRIPE_SECRET_KEY')` and `env('STRIPE_WEBHOOK_SECRET')` into the
    config (an unset variable threw before Settings could fill it); the variables stay in `.env.example`, and the hint
    says to set them in `.env` or in the admin's Settings.
  - **Admin API.** `GET /api/admin/settings` lists each slot's declared fields with their state and source, and never a
    secret's value; `PUT /api/admin/settings/:slot/:path` with `{ value }` saves one and `DELETE` clears it (409
    `settings.set_by_environment`, 404 `settings.unknown_field`, 503 `settings.key_missing`). A write publishes
    `settings.changed.v1` with `{ slot, path, source }` and answers `restartRequired: true`.
  - **No value leaks.** `createApp` wraps whatever logger it is given so no saved secret reaches a log record, and error
    responses are scrubbed the same way. `createLogger` takes a `destination`. `nymbal doctor` reads the saved values
    to check each slot and prints none of them.
  - **CLI.** `nymbal secrets rotate` re-encrypts every saved secret from `NYMBAL_SECRETS_KEY_OLD` to
    `NYMBAL_SECRETS_KEY` in one transaction, or changes nothing and exits 2. `nymbal secrets clear [--slot] [--path]`
    deletes saved values without a key, the recovery for a lost one.
  - **Migration 0008** adds the `settings` table on SQLite and Postgres: run `nymbal migrate`. A store not yet migrated
    boots with no settings.
  - The Anthropic adapter takes `baseUrl` (passed to the SDK as `baseURL`).

### Patch Changes

- 94fcffd: Every page loads only the elements it renders, and the templates carry performance budgets.
  - **Per-element entry points:** `@nymbalhq/web-components/elements/<tag>` exports one element with a static
    `define()`; the package has no import-time side effects (`sideEffects: ["*.css"]`), so a bundler drops what a page
    does not import. `registerComponents()` still defines everything for a page that wants that. Payment drivers
    register in the payment element's `beforeDefine`, not at import.
  - **React:** `@nymbalhq/react`'s root is a facade of pure re-exports; each generated wrapper defines its own element
    in an effect and imports its element's entry point, so Turbopack and webpack tree-shake per page. `NymbalSetup`
    defines the layout's elements.
  - **Templates:** each Astro page's module script and each Next route define exactly what they render; the checkout
    page reserves `nymbal-checkout`'s box before it upgrades, so the footer stays put (CLS 0.68 → 0.01).
  - **Budgets:** `pnpm perf:budgets` measures LCP, CLS, TBT and script bytes on the home, listing, product, cart and
    checkout pages of both templates against `perf-budgets.json` (whole-KiB script budgets at the measured value + 5%;
    the Next cart keeps a 3000 ms LCP exception until server rendering); it refuses ports something else listens on. CI
    runs it, and the production E2E that proves per-page loading, in the `perf-budgets` job.
  - **Fixes:** Astro listing images are no longer lazy above the fold (LCP); the Next filter panel is not rendered on
    phones (CLS); the Next cart no longer shifts after hydration.

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [1653d3f]
- Updated dependencies [3591951]
- Updated dependencies [7d839a4]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
- Updated dependencies [94fcffd]
  - @nymbalhq/platform@1.2.0
  - @nymbalhq/types@1.2.0
  - @nymbalhq/http@1.2.0
  - @nymbalhq/admin@1.2.0
  - @nymbalhq/config@1.2.0
  - @nymbalhq/importers@0.3.1

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

- ea74a39: The storefronts render from what the store's adapters can do, never from which vendor is configured.
  - `GET /api/capabilities` (public) answers the store's report: `payments` (`capabilities`, `client`), `search`
    (`capabilities`) and `catalog` (`sortKeys`, `defaultSort`). It names no provider and serves no secret.
    `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS` are new in `@nymbalhq/types`. The SDK reads the
    report once per client with `client.capabilities.get()`.
  - A payments adapter may describe its storefront half with `client(): { driver, options } | null`, where `options`
    holds public values only. The native stub answers `{ driver: 'test-mode', options: {} }`. Stripe answers
    `{ driver: 'stripe', options: { publishableKey } }`, from the new `publishableKey` in its config or
    `STRIPE_PUBLISHABLE_KEY`; a key that starts `sk_` or `rk_` there fails at start.
  - `<nymbal-payment-element client='<json>'>` (React: `PaymentElement`) renders that client half through a driver
    from the SDK's registry (`registerPaymentDriver(name, driver)`, `getPaymentDriver(name)`), and its
    `confirm(clientSecret, context?)` answers `{ ok: true, confirmed }` or `{ ok: false, error }`. `context`
    (`PaymentConfirmContext`: `email`, `billing`) is the shopper's email and billing address, which both checkouts
    pass and the `stripe` driver sends as `billing_details`. `registerComponents()`
    registers the `test-mode` driver and a `stripe` driver that loads Stripe.js from js.stripe.com, so no project
    installs a Stripe package. A project registers a driver of its own in its client bootstrap; one registered under a
    built-in's name wins. A `null` client renders nothing; an unknown driver shows `payment-element-error`, and the
    checkout keeps Place Order disabled.
  - `<nymbal-sort-dropdown sort-keys value default-sort>` (React: `SortDropdown`) offers the store's sort keys in its
    order and emits `nymbal:sort:changed` with `{ sort }`.
  - Astro's listing script sorts on the dropdown's `nymbal:sort:changed`, so it sorts whichever select the element
    renders. On Astro's checkout, the second click of a double click on shipping Continue, which lands on Place Order,
    no longer places the order.
  - `GET /api/products` leaves out `facets` when the search adapter does not report `facet`. Both templates render the
    product filter only from the listing's facets, the header search bar only when search reports `search`, and the sort
    options from `catalog.sortKeys`.
  - `loadConfig()` returns the config module's named `adapters` export as `adapters`, and `nymbal dev` passes it to
    `createApp`, so a `custom` slot runs under `nymbal dev`.

  **Breaking for a Stripe store and for a scaffolded checkout.** The templates no longer import `@stripe/*`, read
  `PUBLIC_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` or `*_NYMBAL_PAYMENTS_PROVIDER`, and
  `nymbal dev` no longer sets the latter. Give the API the publishable key instead (`payments.config.publishableKey`
  or `STRIPE_PUBLISHABLE_KEY`). The payment step's test id is `payment-element` (was `stripe-card-element` on Astro and
  `card-element` on Next), and Next's `CheckoutForm` takes the report as its `capabilities` prop.

### Patch Changes

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

- 1b6da9e: A store can keep its media in an S3-compatible bucket: `infrastructure.media: 's3'`. Each stored object is
  `<prefix>/<key>` in the bucket, and its URL is the bucket's public URL. The storage is the new `@nymbalhq/media-s3`
  package, which the kernel imports only when the config names it: `npm install @nymbalhq/media-s3 @aws-sdk/client-s3`.
  A missing package fails `createApp` with `adapter.package_missing` and that install line.
  - An optional `infrastructure.s3` block takes `bucket`, `region`, `endpoint`, `prefix`, `publicUrl` and
    `forcePathStyle`. Each falls back to the environment: `S3_BUCKET`, `AWS_REGION`, `S3_ENDPOINT`, `NYMBAL_S3_PREFIX`
    and `S3_PUBLIC_URL`. The region defaults to `us-east-1`, there is no prefix by default, and requests are path-style
    when an endpoint is set.
  - With no bucket in the block or `S3_BUCKET`, `createApp` fails `config.s3_bucket_missing` before anything is loaded.
  - Credentials are never config keys: the AWS SDK's default chain provides them (`AWS_ACCESS_KEY_ID` /
    `AWS_SECRET_ACCESS_KEY`, a profile or a role). Any other key inside the block, and an `s3` block while `media` is
    not `'s3'`, fail `loadConfig` naming the key.
  - A URL is `publicUrl` when it is set, else `endpoint/bucket`, else `https://<bucket>.s3.<region>.amazonaws.com`.
    The object key follows it, with each path segment percent-encoded. The storage never creates buckets or sets
    policies: the bucket must already serve its objects publicly.

  `nymbal import` now writes product images to the store's media storage. With `local-fs` (the default) that is the
  same files under `public/imported-media` with the same `/imported-media/...` URLs as before. The import no longer
  crashes at start on `p.bold is not a function`.

  **Breaking for code that calls the importer (`@nymbalhq/importers`).** `WooCommerceImporterDeps` takes a required
  `media: MediaStorage`, and `runWooCommerceImport` builds no storage of its own: pass `app.platform.media`.
  `WooCommerceImportOptions.projectRoot` stays, but media no longer uses it. A `put` that rejects is now reported, not
  dropped: the product is created with the images that did store, the report's `errors` gets
  `{ phase: 'media', id: <WooCommerce product id>, error }`, and an `error` progress event matches it.

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [1b6da9e]
- Updated dependencies [ea74a39]
  - @nymbalhq/platform@1.1.0
  - @nymbalhq/types@1.1.0
  - @nymbalhq/http@1.1.0
  - @nymbalhq/config@1.1.0
  - @nymbalhq/importers@0.3.0
  - @nymbalhq/admin@1.1.0

## 1.0.0

### Minor Changes

- b1ef5ea: Stopping the store no longer hangs while the admin is open. The Fastify adapter's `stop()` now ends every open
  event stream cleanly and closes its connection. A stream that would open during shutdown gets a 503. Before, an open
  admin tab kept `nymbal dev` running after SIGTERM or SIGINT. After a restart the admin reconnects by itself.

  `nymbal dev` shuts down within 3 s. If a step is still pending at that point, it logs the step's name and exits 1. A
  second SIGINT or SIGTERM during shutdown exits 1 at once. A shutdown step that fails is logged, and the exit code is 1.

  `nymbal dev --port <n>` sets the API port and overrides the config's `http.port`.

### Patch Changes

- Updated dependencies [6571ce9]
- Updated dependencies [ebbfeec]
- Updated dependencies [b1ef5ea]
  - @nymbalhq/platform@1.0.0
  - @nymbalhq/config@1.0.0
  - @nymbalhq/types@1.0.0
  - @nymbalhq/importers@0.2.1
  - @nymbalhq/admin@1.0.0
  - @nymbalhq/http@1.0.0

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 22b4523: Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
  seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
  `pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
  payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
  project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
  tells the storefront to skip Stripe unless the configured provider is `stripe`.

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
- e45d84d: Fix the headline `create-nymbal-app` → `nymbal dev` launch so a flat scaffold serves a live storefront with real demo content and zero external services.
  - `nymbal dev` now starts the storefront directly in the project root for a flat scaffold (detected by the framework config), instead of `pnpm --filter @nymbalhq/template-astro`, which matched the wrong package inside a workspace and nothing outside one.
  - The storefront port is now configurable (`--storefront-port` / `NYMBAL_STOREFRONT_PORT`) and falls through to the next free port when the default (4321 Astro / 3000 Next.js) is busy, so an unrelated project on the default port no longer blocks the launch. The free-port probe is IPv6-aware.
  - `resolveMigrations` no longer relies on `require.resolve('@nymbalhq/platform/package.json')` (the package's exports map is ESM-only and does not expose it), which previously broke auto-migrate in a scaffolded project ("Can't find meta/\_journal.json"). It now locates the installed package directory directly.
  - The Astro template honours `NYMBAL_STOREFRONT_PORT` (config-driven) so a bare `pnpm dev` degrades gracefully on a busy port, and the project-override homepage marker is rendered as a real (hidden) element so it survives SSR (Astro strips bare leading comments).

- e29919d: Honest storefront templates.
  - **SDK.** `client.customer.addresses.{list,create,remove}` and `client.customer.orders.{list,get}` call the account
    routes that exist, with the bearer token and the envelope unwrapped.
  - **Account pages.** Both templates' account pages now use these SDK calls, so a signed-in shopper sees their
    profile, addresses and orders. An order opens by its order number.
  - **Next.js template.** Sign Out revokes the session, a reload keeps a signed-in shopper signed in, and the account
    area can add an address.
  - **Search.** Choosing a search suggestion, by click or keyboard, opens the product on both templates.
  - **Upgrades.** The templates move to Astro 7 and Next 16 with React 19.
    - `@nymbalhq/react` now targets React 19 types: its peer range is `>=19`, and the generated JSX declarations augment
      `react` rather than the global namespace. That is breaking for React 18 consumers (pre-1.0, so a minor).
    - `nymbal dev` passes `--ignore-lock` to `astro dev`, so Astro 7 stays in the foreground when an AI agent runs it.
  - **Typecheck.** The root typecheck now runs `astro check`, and the scaffold is re-synced.
- Updated dependencies [d12c7ec]
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [1743000]
- Updated dependencies [ccd3d36]
- Updated dependencies [ac2b2bb]
- Updated dependencies [edababa]
- Updated dependencies [22b4523]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e90bf2d]
  - @nymbalhq/admin@0.2.0
  - @nymbalhq/platform@0.2.0
  - @nymbalhq/types@0.2.0
  - @nymbalhq/importers@0.2.0
  - @nymbalhq/config@0.2.0
  - @nymbalhq/http@0.2.0
