# @nymbalhq/platform

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 1.2.0

- Every write leaves an audit entry, and admin writes accept an `Idempotency-Key` that applies them once. See
  `/admin/activity` and `nymbal audit export`.
- Every event carries its operation's correlation id (`x-correlation-id`); `nymbal events query|tail` read the log, and
  `events.retentionDays` with an optional private S3 archive manage old events.
- `nymbal replay --to <model>` rebuilds a read model from the tables, and boot rebuilds every read model. A custom
  document store must implement `replaceCollection`.
- Provider keys can be saved in the admin's Settings, encrypted under `NYMBAL_SECRETS_KEY`. Back the key up: a store
  holding saved secrets does not start without it. Run `nymbal migrate`.
- `security.adapter: 'cloudflare'`, third-party adapters certified with `nymbal test:contracts --package`, and Node 26.
  **Breaking:** `'aws-waf'` and `'akamai'` now fail at start; use `middleware` or `cloudflare`.

## 1.1.0

- `nymbal dev` starts quietly, and `nymbal doctor` checks a project without changing it; primitives may implement
  `healthCheck()`.
- Native full-text search in the store's own database, with cursor pages, totals and category facets. Run
  `nymbal migrate`. **Breaking:** a query matches word prefixes, not substrings.
- `nymbal add redis|postgres|s3|stripe`, and Redis or Postgres JSONB read models, a Redis Streams bus and S3 media, each
  in its own package.
- Storefronts render from `GET /api/capabilities`. **Breaking:** templates no longer read Stripe variables; give the API
  `STRIPE_PUBLISHABLE_KEY` (or `payments.config.publishableKey`).
- **Breaking:** delete `infrastructure.cloud` and `infrastructure.compute`; code that calls `createPlatform` passes the
  primitives from `resolvePrimitives(config)`; `<nymbal-variant-selector>` takes `VariantOption[]` only.

## 1.0.0

- Provider SDKs live in `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and `@nymbalhq/adapter-smtp`: install
  the one your config names.
- **Breaking:** unknown providers fail `loadConfig`. Use `ai: { provider: 'none' }` for no AI and
  `email: { provider: 'smtp' }` for SMTP mail.
- **Breaking:** an adapter's `capabilities` is a method, `capabilities()`.
- `createApp(config, { adapters })` puts your own adapter in a `custom` slot.

## 0.2.0

- First release under `@nymbalhq`.
- Real transactions, durable events, persistent carts and a checkout that completes; concurrent checkouts no longer
  oversell.
- Orders record captured and refunded money, and refunds go through the payments adapter by amount. **Breaking:**
  `partial-refund` is gone, and a `PaymentsAdapter` must implement `cancelPaymentIntent` and `getPaymentIntent`.
- CSRF on every write, login rate limits, roles in a `customers.roles` column and a schema on every route. **Breaking:**
  `http.trustProxy` defaults to `false`; set it to `true` behind a proxy.
- Sorting with `?sort=`, verified Stripe webhooks, and a production store that refuses the stub payments adapter and the
  default JWT secret.
