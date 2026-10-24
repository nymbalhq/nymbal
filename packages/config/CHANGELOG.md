# @nymbalhq/config

## 1.1.0

### Minor Changes

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
- Updated dependencies [ea74a39]
  - @nymbalhq/types@1.1.0

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
  - @nymbalhq/types@1.0.0

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
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

- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [ccd3d36]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e90bf2d]
  - @nymbalhq/types@0.2.0
