# @nymbalhq/types

## 1.4.0

### Minor Changes

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- 295dab6: Back-in-stock alerts: `POST /api/alerts/subscribe` emails a confirmation, and `/api/alerts/confirm` and `/api/alerts/unsubscribe` take the token from its links. A variant whose stock rises from 0 publishes `product.restocked.v1`, and each confirmed subscriber gets one email. Adds the `alert_subscriptions` migration; subscribe is limited to 10 per IP per hour and answers 409 on a store whose email is `native`.
  `GET /api/capabilities` reports `email.delivers`.
  Breaking for a kernel composed by hand: `buildServices` now takes `email` (the email adapter), `registerHandlers` takes `alerts` (the alert service), and `registerCapabilitiesRoute` needs `adapters.email`.
- d724fd2: Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
  The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
- 6f73872: Any commerce adapter can take webhooks at `POST /api/webhooks/<providerName>` by implementing the optional `receiveWebhook(rawBody, headers)`; a delivery sent twice, even at once, is processed once. Its events must be named `<providerName>.<event>.v<n>` and listed in `producesEvents`, each payload a plain JSON object. `/api/webhooks/stripe` is unchanged.
  `runWebhookContract` certifies an adapter's `receiveWebhook`, and `webhookDeliveryProblem` from `@nymbalhq/types` gives the rule both apply, the first reason a delivery is refused or null.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- c8588b2: Storefronts that import `@nymbalhq/types` no longer ship the list of kernel event types in their client bundles.

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

## 1.2.0

- Audit and idempotency types: `AuditEntry`, `AuditActor`, `isValidIdempotencyKey` and the header names.
- `AdapterSetting`: a provider package declares the settings the admin can fill.
- `DocumentStoreAdapter.replaceCollection` is required, and `SearchAdapter.replaceAll` optional.
- **Breaking:** `Slot` includes `security`, and `ProviderPackage.sdk` is optional.

## 1.1.0

- `healthCheck()` on primitives, with `boundedHealthCheck` and `HEALTH_CHECK_TIMEOUT_MS` to implement it.
- `Recipe`, `stockLevel()` and `STOCK_LABELS`, `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS`.
- `compareDocumentValues`, `matchesSortKey` and `queryDocuments`, the order every document store follows. **Breaking:**
  values of different types rank by type, so `1` and `'1'` differ, and nulls sort last.
- Search pages by cursor with a `total`, and `FacetParams.query` is new.
- `MediaStorage` lives here, and `AdapterContext.slot` is a `Slot`.

## 1.0.0

- **Breaking:** an adapter's `capabilities` is a method, `capabilities()`.

## 0.2.0

- First release under `@nymbalhq`.
- `Order` carries captured and refunded amounts, with `paymentState()` and `refundableMinor()`.
- **Breaking:** `PaymentsAdapter` gains `cancelPaymentIntent`, `getPaymentIntent` and refund options; `Customer.roles`
  is required.
- `EventBusAdapter.replay` and `ProductSortKey`.
