# @nymbalhq/types

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
