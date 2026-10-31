# @nymbalhq/platform

## 1.5.0

### Minor Changes

- 6c85536: Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
  (from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
  (from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
  Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.
- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.
- 0b51500: A subscribe for a stock or price alert that is already active is logged as `alert.repeated.v1`; nothing is sent.
- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
- 5db4e1b: `nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
  (`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
  writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
- 39c852e: Commands print slots in kebab case (`document-store`, `event-bus`): doctor's checks, `nymbal dev` and `config:validate`; `test:contracts --slot` accepts either spelling.
  Breaking: a script reading `nymbal doctor --json` matches `primitive document-store` and `primitive event-bus` (and the same for `package`) now, in place of the camelCase names; `config:validate`'s summary says `command store:` in place of `commandStore:`.
- 59e1639: New `easypost` shipping provider (`@nymbalhq/shipping-easypost`): set `shipping.provider: 'easypost'`, and its tracker
  webhooks (`/api/webhooks/easypost`) mark a shipped order delivered.
- 965b85a: Email adapters can report bounces and complaints from `receiveWebhook` as `<provider>.bounced.v1` and
  `<provider>.complained.v1`; a hard bounce or a complaint stops alert mail to that address. Webhooks may be
  form-encoded or plain text. `runEmailFeedbackContract` certifies an email adapter's bounces and complaints.
- ca1a5f6: A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
  set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
  `http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
  rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
  Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
- 95dad2e: New `mailgun` email provider (`@nymbalhq/email-mailgun`): it sends over Mailgun's SMTP relay, and its bounce and
  complaint webhooks stop alert mail to bad addresses. Set Mailgun's webhook URL to `/api/webhooks/mailgun`.
- c778b26: Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
  or asks for a new link. Signed-in shoppers go to their account's order page.

  Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
  makes every field the confirmation page does not show optional.

- 0b51500: A delivery that fails while the event bus, document store or a commerce adapter reports itself down no longer uses
  up the event's retries: it is tried again at a steady pace and sent once the adapter is back. Each such pass logs one
  `outage:` warning naming what is down.
- a67f867: New `resend` email provider (`@nymbalhq/email-resend`): it sends over Resend's SMTP relay, and its bounce and
  complaint webhooks stop alert mail to bad addresses. Set Resend's webhook URL to `/api/webhooks/resend`.
- ab6c631: New `ses` email provider (`@nymbalhq/email-ses`): it sends over Amazon SES SMTP, and its SNS bounce and complaint
  notifications stop alert mail to bad addresses. Subscribe the SNS topic to `/api/webhooks/ses` over HTTPS.
- d9c8c5a: Shipping adapters can report tracking updates from `receiveWebhook` as `<provider>.tracking.v1`; a delivered update
  marks the shipped order delivered. `runShippingTrackingContract` certifies a shipping adapter's tracking updates.
  Breaking for a kernel composed by hand: `registerHandlers` takes `orders` (the order service).

### Patch Changes

- eed87ad: Concurrent first checkouts on a new Postgres store no longer fail with a duplicate key error on the order number.
- 733d4b1: A store whose adapter loads its own copy of `@nymbalhq/types` now fails to start, naming both copies, instead of
  mishandling that adapter's errors.
- 86724f2: `nymbal replay` no longer hides products and other changes made while it rebuilds: each read model is caught up before it is swapped in.
- Updated dependencies [f05e635]
- Updated dependencies [0b51500]
- Updated dependencies [bb453b8]
- Updated dependencies [59e1639]
- Updated dependencies [965b85a]
- Updated dependencies [ca1a5f6]
- Updated dependencies [95dad2e]
- Updated dependencies [c778b26]
- Updated dependencies [a67f867]
- Updated dependencies [ab6c631]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
  - @nymbalhq/config@1.5.0
  - @nymbalhq/types@1.5.0

## 1.4.0

### Minor Changes

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- 295dab6: Back-in-stock alerts: `POST /api/alerts/subscribe` emails a confirmation, and `/api/alerts/confirm` and `/api/alerts/unsubscribe` take the token from its links. A variant whose stock rises from 0 publishes `product.restocked.v1`, and each confirmed subscriber gets one email. Adds the `alert_subscriptions` migration; subscribe is limited to 10 per IP per hour and answers 409 on a store whose email is `native`.
  `GET /api/capabilities` reports `email.delivers`.
  Breaking for a kernel composed by hand: `buildServices` now takes `email` (the email adapter), `registerHandlers` takes `alerts` (the alert service), and `registerCapabilitiesRoute` needs `adapters.email`.
- d724fd2: Breaking in effect for your own handlers: a named handler that throws is now retried, up to five times over about 2.5 minutes, before its event is dead, so make it idempotent (for example with `withIdempotency`). `createApp` takes `relay` options for the attempts and the delay.
  Migration `0015` adds `events.retry_at`. `nymbal doctor` lists dead events, and `nymbal events query --json` prints `attempts` and `deadAt`.
- d724fd2: Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
  The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
- 63ede12: An order page and `GET /api/orders/:orderNumber` now need the order's key (checkout answers `orderKey`, sent as the `x-nymbal-order-key` header; the page is `/order/<n>?key=<key>`) or the owner's session; anyone else gets 404. Set `store.url` so the order email links to the order. Run `nymbal migrate`.
  Breaking: a store scaffolded from an older template takes four files from the new one, or its confirmation page shows "not found". Astro: `src/pages/checkout.astro`, `src/pages/order/[orderNumber].astro`, `src/scripts/order-status.ts`, `src/lib/api.ts`. Next: `app/(shopper)/checkout/CheckoutView.tsx`, `app/(shopper)/order/[orderNumber]/page.tsx`, `components/client/OrderStatusRefresh.tsx`, `lib/api.ts`.
- 6f73872: Any commerce adapter can take webhooks at `POST /api/webhooks/<providerName>` by implementing the optional `receiveWebhook(rawBody, headers)`; a delivery sent twice, even at once, is processed once. Its events must be named `<providerName>.<event>.v<n>` and listed in `producesEvents`, each payload a plain JSON object. `/api/webhooks/stripe` is unchanged.
  `runWebhookContract` certifies an adapter's `receiveWebhook`, and `webhookDeliveryProblem` from `@nymbalhq/types` gives the rule both apply, the first reason a delivery is refused or null.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.
- d546cd3: Breaking: `createNativeAiAdapter` is removed; it threw on every call. Set `ai: { provider: 'none' }` or `'anthropic'` in its place.
  `runAiContract` and the `ai` kind of `nymbal test:contracts` are removed; test a custom AI adapter with your own suite.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- d546cd3: The refresh cookie's Max-Age follows `security.auth.refreshTtl`, so it no longer outlives the token it carries.
- ea1926d: `GET /api/orders` and `GET /api/orders/:orderNumber` no longer return an order's internal fields: `metadata` is `{}`, `notes` is `''` and `paymentIntentId` is `null`. The admin order routes still return them.
- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0
  - @nymbalhq/config@1.4.0

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
