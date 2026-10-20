# @nymbalhq/http

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
