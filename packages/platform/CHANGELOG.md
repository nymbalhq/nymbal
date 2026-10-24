# @nymbalhq/platform

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

- f93dab3: The `native` search provider is full-text search in the store's own database: SQLite FTS5 on a SQLite store, a
  GIN-indexed `tsvector` on Postgres. Every match is reachable through cursor pages with an exact total.
  - Migration 0007 creates the search tables (`search_documents`, and on SQLite its FTS5 index). Run
    `nymbal migrate`. A store that had products before 0007 indexes them on its next start, from the warm-up replay.
  - `createNativeSearchAdapter({ sql, logger })` takes the command store's raw clients (`rawClients(store)`), not a
    document store. `BuildAdaptersDeps` takes `sql` in place of `documentStore`. The `search-index` document-store
    collection is no longer written.
  - Results are ranked: products with every query term in the name come first, then products with every term in the
    name, a SKU or a variant name, then the rest by the engine's score, then by id.
  - `search` pages by `cursor`. `nextCursor` is null on the last page, and `total` counts every match. A malformed
    cursor is an error, and a cursor past the last match is an empty last page. `encodeSearchCursor(offset)` is
    exported. `filters.categoryIds` narrows to a category, with filters applied as well as the query.
  - `FacetParams.query` is new: `facet('categoryIds', { query, filters })` counts the query's matches per category.
  - `GET /api/products/search` takes `category=<slug>` and answers `{ items, nextCursor, total, facets }`. `facets` is
    the category facet in the listing's shape (slug values, name labels) when search reports `facet` and the query
    matches. An unknown category gives no items and a total of 0. A malformed cursor is a 400.
  - The SDK's `products.search(query, { limit, cursor, category })` returns `total` and `facets`. The search store
    gains `loadMore()` and `setCategory(slug | null)`, and `SearchState` gains `category`, `nextCursor` and `facets`.
    Its `total` is now the API's total, not the number of results loaded. `useSearch` exposes the same.
  - `<nymbal-product-filter source="search">` (React: `ProductFilter source="search"`) renders the search's facets and
    narrows the search to the category chosen. Choosing the chosen category again clears it.
  - Both templates' `/search` show the API's total (`search-total`), a Load more button (`search-load-more`) while
    pages remain, and the category filter when the search has facets. The filter writes `?category=` beside `?q`.

  **Behaviour change in matching.** A query is split into terms: runs of ASCII letters and digits, lowercased.
  Everything else separates terms, and that includes non-ASCII letters. Each term must be a prefix of a word in the
  product's name, SKU, variant name or description. The old match was a substring anywhere in the product. So
  `ool` no longer finds "wool", `foo.bar` finds products with words starting `foo` and `bar`, a query with no terms
  finds nothing, and a match in a field other than these four (a slug, a price) no longer counts.

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

- 6f72118: The product page adds the quantity and the variant the shopper picks, the same way on both templates.
  - `@nymbalhq/types` exports the one stock rule, `stockLevel(stock)` (`'out'` at 0 or below, `'low'` below 5, else
    `'in'`), and `STOCK_LABELS`. Both PDP badges render from it, with `data-level` on `stock-badge`. Add-to-cart is
    disabled exactly when the selected variant's stock is 0 or below, and a product with no variants is out of stock.
  - `<nymbal-add-to-cart qty>` (React: `qty`) adds that many units: a whole number clamped to 1-99, and anything else
    is 1. `nymbal:cart:item-added` carries `{ variantId, qty }`.
  - Both PDPs wire a `<nymbal-quantity-selector>` to add-to-cart, and the quantity starts again at 1 when the variant
    changes. `<nymbal-quantity-selector>` shows and emits a whole number: a typed or set value is truncated toward zero
    and clamped to `min`-`max`, and anything that is not a number is `min`, so a typed 2.7 shows and adds 2. Astro's
    `/cart` steps each line with `<nymbal-quantity-selector>`, as Next does. On both templates, decrement stops at 1 and
    the line's `cart-remove-<variantId>` button removes it.
  - The product read model always serves `variants[].options` as `VariantOption[]`, including for products projected
    from older events that stored the options as a JSON string.

  **Breaking.** `<nymbal-variant-selector>` takes variant options as `VariantOption[]` only. Its `options` attribute
  (React: the `options` prop) is gone, so the selector reads its groups from the product's variants alone. On Astro's
  `/cart`, decrement at 1 no longer removes the line. Next's unused `components/server/StockBadge.tsx` is removed.

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

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [1b6da9e]
- Updated dependencies [ea74a39]
  - @nymbalhq/types@1.1.0
  - @nymbalhq/config@1.1.0

## 1.0.0

### Minor Changes

- 6571ce9: Provider SDKs leave the kernel. `@nymbalhq/platform` no longer depends on `stripe`, `@anthropic-ai/sdk` or
  `nodemailer`: each lives in its own package, `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and
  `@nymbalhq/adapter-smtp`, which the kernel imports only when `nymbal.config.ts` names its provider. A store that uses
  one installs it and its SDK (`npm install @nymbalhq/adapter-stripe stripe`); if it is missing, `createApp` fails with
  `adapter.package_missing` and prints that line for the package manager in use.

  **Breaking: the config only accepts providers it knows.** Each commerce slot's `provider` is now one of
  `KNOWN_PROVIDERS` (exported by `@nymbalhq/config`): payments `native` or `stripe`; email `native` (console) or `smtp`;
  ai `none` or `anthropic`; reviews, search, analytics, shipping and tax `native`; and `custom` for every slot. Any other
  string, which used to load and silently run the native stub, now fails `loadConfig` naming the slot and the providers
  it accepts. In particular:
  - `ai: { provider: 'native' }` is no longer accepted: use `ai: { provider: 'none' }`, which builds no AI adapter
    (`app.adapters.ai` is `null`, and the admin's AI route answers 503).
  - SMTP mail moves from `email: { provider: 'native', config: { transport: 'smtp', smtp } }` to
    `email: { provider: 'smtp', config: { smtp } }` plus `@nymbalhq/adapter-smtp` and `nodemailer`. The old form fails
    `loadConfig` instead of printing mail to the console.
  - The Anthropic key is read from `ai.config.apiKey`, falling back to `ANTHROPIC_API_KEY`.

  **`createApp(config, { adapters })`** takes a project's own adapter for any slot whose provider is `custom`. A `custom`
  slot with nothing injected, or an adapter injected for a slot that is not `custom`, fails with
  `adapter.custom_mismatch`. `nymbal dev` and `nymbal start` cannot inject adapters yet. In production the stub-payments
  refusal reads the resolved adapter, so an injected stub is refused and an injected real adapter starts.

  **Capabilities.** `capabilities` is now a method, `capabilities(): readonly string[]`, on every adapter, the document
  store, the event bus and `MediaStorage`; adapters written against the old `capabilities` array must become a function.
  `app.capabilities()` reports each slot's provider and its adapter's answer. The native payments stub no longer lists
  `webhook`, since it verifies no signature.

  The kernel no longer exports `createStripePaymentsAdapter` or `createAnthropicAiAdapter` (import them from the adapter
  packages), and `createNativeEmailAdapter` keeps only the console transport. A new project's config defaults ai to
  `none`, so a fresh store installs no provider SDK. The WooCommerce importer skips AI enrichment when the store has no
  AI provider.

### Patch Changes

- Updated dependencies [6571ce9]
  - @nymbalhq/config@1.0.0
  - @nymbalhq/types@1.0.0
  - @nymbalhq/adapter-stripe@1.0.0
  - @nymbalhq/adapter-anthropic@1.0.0
  - @nymbalhq/adapter-smtp@1.0.0

## 0.2.0

### Minor Changes

- 4e7e079: The admin tells the truth about money. Orders store what was captured and refunded (migration `0006`:
  `orders.captured_minor`, `captured_at`, `refunded_minor`, `capture_method`, and an `order_refunds` table; existing
  orders are backfilled from their status). `Order` gains `capturedMinor`, `capturedAt`, `refundedMinor` and
  `captureMethod`, and `@nymbalhq/types` exports `paymentState(order)`, `refundableMinor(order, refunds)`, `OrderRefund`
  and `OrderPayment`. Admin order reads carry `payment: { state, capturedMinor, refundedMinor, refundableMinor,
currency, refunds }`.

  `POST /api/admin/orders/:id/refund { amountMinor, reason? }` now moves money through the payments adapter (once per
  refund, keyed by the refund's id) and answers `{ order, payment, refund }`; it refuses 409 `refund.not_captured` and
  `refund.exceeds_captured`. `partial-refund` is gone: every refund is by amount. `mark-paid` takes `{ note? }` and
  records a manual capture of the order's total, confirming it like a payment (409 `order.stock_unavailable` when its
  released stock is gone). `confirm` refuses an unpaid order (409 `order.unpaid`), `cancel` a paid one (409
  `order.paid`), and a transition the status table forbids answers 409 `status.invalid_transition`. A capture refunded
  because its order was cancelled is recorded, so the order nets to zero. Dashboard revenue and customer spend count
  captured less refunded.

  `PaymentsAdapter.refund` gains `opts: { idempotencyKey?, currency? }` and throws `PaymentError('refund_rejected')` when
  no money moved or `PaymentError('refund_unknown')` when it may have (`refund_failed` is gone). The `native-stub` adapter
  refunds like a provider: it refuses an id it did not mint, an uncaptured intent and an over-refund. Order refund
  events carry `refundId` and `currency`, and `order.partially_refunded` drops `lineItems`. The WooCommerce importer
  records paid orders as captured. The admin shows a Payment panel and column, refunds by amount, and records a payment
  instead of confirming an unpaid order.

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 26fd94a: A checkout that completes. `POST /api/checkout` now answers the payment outcome (`payment: { status: 'succeeded' |
'requires_action' | 'failed', reason? }` and `orderStatus`). When the payments adapter captures at once, as the
  `native-stub` adapter now does, the order is confirmed, its stock committed and its cart emptied in the same request;
  Stripe orders are still confirmed by the webhook. The stub takes test triggers from the receipt email: a local part
  ending `+stub-pending` stays pending, `+stub-decline` fails. One cart has at most one pending order (migration `0005`,
  `orders.cart_token` with a partial unique index): a resubmit answers the same order, a changed cart cancels the old
  intent and supersedes its order (409 `checkout.payment_in_progress` when the provider refuses), an emptied cart
  answers 409 `checkout.cart_empty` naming the order it became, and a pending order left without an intent is
  abandoned after 120 s. A capture for a cancelled order, or one that cannot confirm its order, is refunded. The
  `order-placed` email is sent once per order on `order.paid`, not on `order.placed`, so an unpaid or imported order
  sends none.

  `PaymentsAdapter` gains `cancelPaymentIntent(intentId)` and `getPaymentIntent(intentId)`, and
  `PaymentIntentParams.receiptEmail`; a third-party adapter must implement both methods. In the SDK,
  `checkout.submitPayment()` resolves to the server's result (or `null`), `paymentStatus` is `succeeded` only when the
  server says so and `requires_action` while Stripe must confirm, `checkout.markConfirmed()` is new, and the cart store
  reloads after a submit. Both templates follow `payment.status`, and their order pages show the order's real state
  ("Awaiting payment" for a pending order).

- ccd3d36: Durable events. Every event is written to a new `events` table in the transaction whose writes it describes, and a
  relay delivers it after commit; a process killed between commit and delivery delivers on the next start. A failed
  delivery stays queued and is retried (up to five attempts) without failing the command that published it. Handler
  idempotency records live in the command store (`processed_events`), so a restart no longer forgets them, and warm-up
  rebuilds projections and search through the new `EventBusAdapter.replay` (subscriptions marked `derived`) instead of
  re-publishing to every subscriber, so restarting no longer re-sends order confirmations and welcome emails. Delivered
  events and idempotency records older than 30 days are removed by a retention sweeper. `createEventPublisher` now
  requires `store`, `eventLog` and `relay` (`createRelay`). The in-memory document store treats a partition value of
  `'*'` as a full scan, which the cart-abandonment sweeper relies on.
- ac2b2bb: Persistent carts. Carts are rows in a new `carts` table in the command store (migration `0003`), so a restart keeps
  every cart and any number of API processes on one database serve the same cart. Every cart command locks its row and
  appends its events in the same transaction, so concurrent adds no longer lose an update. Cart expiry slides with each
  write (30 days by default); an expired cart reads as missing and the abandonment sweeper deletes it. The sweeper no
  longer stops at 1,000 carts and records each notice in the table, so a cart gets one `cart.abandoned` per idle period
  across restarts and processes. Checkout finalisation empties the cart in the same transaction that confirms the
  order, and a cart that expired before payment no longer blocks the order. `createCartService` takes `store` and
  `carts` (from `buildRepositories(...).cart`) instead of `documentStore`; `createCheckoutService` and `buildServices` no
  longer take `documentStore`; `startCartAbandonmentSweeper` takes `store` and `carts` plus optional `batchSize` and
  `now`.
- edababa: Real command-store transactions on SQLite and Postgres. `CommandStore` now exposes `read` and `transaction` (which joins
  an open transaction in the same call chain); repository reads take a `ReadTx` and writes a `Tx`, and `rawClients` is
  the way to the Drizzle clients for migrations, seeding and tests. Stock moves by conditional updates
  (`decrementStock`/`incrementStock`), so concurrent checkouts no longer oversell; events published inside a transaction
  are delivered after it commits and dropped on rollback; `finalize` finds its order by payment intent through a new
  index; the reservation sweeper returns the stock of expired reservations and exposes `tick()`.
- 22b4523: Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
  seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
  `pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
  payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
  project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
  tells the storefront to skip Stripe unless the configured provider is `stripe`.
- 97944c3: Every route the store serves now passes one security guard, however the store is started.

  **CSRF.** The Fastify adapter runs the guard on every route before auth and handler. A POST, PUT, PATCH or DELETE
  without a `nymbal.csrf` cookie and an equal `x-csrf-token` header answers 403 `csrf.invalid`, unless the route was
  registered with `csrf: false` (the Stripe webhook). `GET /api/csrf` returns the token in its body and sets the cookie.
  The SDK, the admin and both templates fetch it once and send the header, and refetch once on a `csrf.invalid`. The
  storefront and the API must be on the same site, as the cart cookie already requires.

  **Rate limits.** Built-in rules sit under `security.rateLimit`, and a configured rule for the same path replaces its
  default:
  - `/api/auth/login`: 10 failed attempts per 15 minutes, per IP and per account email. A successful login clears that
    account's count. A blocked login answers 429 `rate_limit.block` with `Retry-After`, even with the right password.
  - `/api/auth/register`: 10 per hour per IP.

  **Breaking:** `http.trustProxy` now defaults to `false`, so `X-Forwarded-For` is ignored. Behind a proxy or load
  balancer, set `http.trustProxy: true`, or every client shares the proxy's IP for rate limiting.

  **Roles.** Roles moved from `customers.metadata.roles` to a `customers.roles` column (migration 0004 backfills it with
  the known roles only). Tokens read the column alone, so writing `metadata` can no longer grant `admin`.
  `Customer.roles` is required.

  **Input validation.** Every platform route has a Zod schema in the exported `routeSchemas` registry, keyed
  `"<METHOD> <path>"`. A route without one refuses to register. Params, query and body are parsed before the handler, so
  unknown keys are stripped and bad input answers 400 `validation.failed` with `context.issues`.

  **Error statuses.** `ValidationError` answers 400. `CheckoutError` answers 409 for `cart_empty`, `out_of_stock` and
  `reservation_failed`, and 422 for `variant_missing`. `finalize_failed` stays 500.

- 07d451c: Sort works. `GET /api/products?sort=` takes `newest` (the default), `price-asc`, `price-desc`, `name-asc` or `name-desc`, ties broken by slug; an unknown key, or a cursor from another sort, answers 400. Breaking in the SDK: `productList.setSort(key)` takes a `ProductSortKey` instead of `(field, direction)`, `state.sort` is that key. `load(params)` defines the listing: its `sort` and `category` become the active ones, and a `load(params)` without `sort` resets the sort to `newest`; `load()` with no arguments reloads the current sort and category, and `setSort` and `loadMore` keep them. A response that arrives after a newer request is dropped. `QueryParams.orderBy` orders a document-store query without filtering it. Both templates offer the same five sorts, keep them in `?sort=`, and render that order on the server. Category facet counts on `GET /api/products` now always count the whole catalogue.
- e90bf2d: Verified Stripe webhooks and recorded payment outcomes.

  **Signatures.** The Fastify adapter keeps the exact request bytes for routes registered with `rawBody: true`. It still
  parses JSON with Fastify's own parser, so a malformed, empty or prototype-poisoned body still gets 400. The Stripe
  webhook verifies those exact bytes, and a bad signature answers 400 `webhook.invalid` instead of 500.

  **Captured payments.** `checkout.finalize(intent, { amountMinor, currency })` confirms an order only when the captured
  amount and currency equal its total. Every other capture is recorded with a reason, answered 200 so Stripe stops
  retrying, and published as `payment.failed` with an order-history note. The reasons are:
  - `amount_mismatch`, `order_not_pending`, `no_order` and `malformed_capture`;
  - `stock_unavailable`, for a payment that arrived after its reservation expired and whose stock is gone.

  A late payment re-takes its stock when it can. The `pending → confirmed` write is conditional and a failed re-take
  re-reads the order, so concurrent deliveries confirm an order once. Webhook dedupe moved to the command store and is
  recorded only when its work commits, so a failed delivery is retried and a restart forgets nothing.

  **Production refusals.** `createApp` refuses to start with the stub payments adapter or the default JWT secret.
  `ConfigError` takes an optional `code`. `DEFAULT_JWT_SECRET` is exported from `@nymbalhq/config`.

  **Kernel.** `CommandStore.savepoint(fn)` rolls back only `fn`'s writes inside an open transaction.
  `inventory.tryReserveStock` returns null on short stock instead of throwing.

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [ccd3d36]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e90bf2d]
  - @nymbalhq/types@0.2.0
  - @nymbalhq/config@0.2.0
