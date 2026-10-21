# nymbal

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
