# @nymbalhq/http

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

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [1653d3f]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0
  - @nymbalhq/config@1.2.0

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

### Patch Changes

- b1ef5ea: Stopping the store no longer hangs while the admin is open. The Fastify adapter's `stop()` now ends every open
  event stream cleanly and closes its connection. A stream that would open during shutdown gets a 503. Before, an open
  admin tab kept `nymbal dev` running after SIGTERM or SIGINT. After a restart the admin reconnects by itself.

  `nymbal dev` shuts down within 3 s. If a step is still pending at that point, it logs the step's name and exits 1. A
  second SIGINT or SIGTERM during shutdown exits 1 at once. A shutdown step that fails is logged, and the exit code is 1.

  `nymbal dev --port <n>` sets the API port and overrides the config's `http.port`.

- Updated dependencies [6571ce9]
  - @nymbalhq/config@1.0.0
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
  - @nymbalhq/config@0.2.0
