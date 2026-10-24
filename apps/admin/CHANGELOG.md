# @nymbalhq/admin

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

## 1.1.0

## 1.0.0

### Patch Changes

- ebbfeec: The admin and the Astro account pages fit a phone. Below the `md` breakpoint (768 px) the admin sidebar is off-canvas:
  a menu button in the top bar (`data-testid="admin-nav-toggle"`, `aria-expanded`) opens it over the page, and choosing
  a link or tapping the backdrop closes it; `main` and the top bar drop their 240 px offset and the live ticker is
  hidden. The dashboard, order detail, product edit, customer profile and media grids stack on narrow screens. At `md`
  and up the admin is unchanged. The Astro account sidebar no longer widens the page on a phone (468 px at 412): its
  link row scrolls inside the column.

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

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
