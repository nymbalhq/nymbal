# @nymbalhq/admin

## 1.4.0

### Minor Changes

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- 157e040: After the API restarts or the connection drops, the admin's live lists refetch, so an order placed in the gap shows without a reload.
- 8e06b03: A long customer email wraps on the customer and order pages, so they fit a phone's width.

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

## 1.2.0

- Activity page (`/admin/activity`): the audit trail of every write, filtered by actor, command, record or correlation
  id, with an NDJSON export. Every write sends an `Idempotency-Key`, so a double click applies once.
- Settings page: enter the provider keys the config leaves unset. Each is saved encrypted, never shown again, and
  applied when the store restarts.
- The stock-history drawer shows a variant's adjustments.

## 1.1.0

- Versioned with the other packages; no changes of its own.

## 1.0.0

- Fits a phone: below 768 px the sidebar folds behind a menu button and the pages stack.

## 0.2.0

- First release under `@nymbalhq`.
- Served by `nymbal dev` at `/admin/`; a reload keeps the merchant signed in, and orders arrive live.
- A Payment panel shows what was captured and refunded. Refunds are by amount, and an unpaid order is marked paid rather
  than confirmed.
