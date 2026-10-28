# @nymbalhq/sdk

## 1.4.0

### Minor Changes

- 295dab6: `<nymbal-notify-me>` (`NotifyMe` in `@nymbalhq/react`) shows the selected variant's back-in-stock form while it is out of stock; the SDK adds `client.adapter.alerts.subscribe()`.
  Breaking for a custom `CommerceAdapter`: add `alerts.subscribe({ email, variantId, kind })`.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.

### Patch Changes

- 75989c8: Requests refused with an expired access token while a token refresh is in flight now wait for that one refresh and are sent again with the new token, rather than failing. A custom `FetchClient` whose `onUnauthorized` refreshes through the same client should pass `{ authRefresh: true }` on that request; an unmarked refresh that is refused is cut off after 10 seconds with the original 401.
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

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- The product-list store reports `loading: true` first, so a server-rendered grid keeps its cards until the store
  settles.

## 1.1.0

- `products.search(query, { limit, cursor, category })` returns `total` and `facets`; the search store gains
  `loadMore()` and `setCategory()`.
- `client.capabilities.get()` reads the store's capabilities; `registerPaymentDriver` adds a payment driver.

## 1.0.0

- Versioned with the other packages; no changes of its own.

## 0.2.0

- First release under `@nymbalhq`.
- Sends the CSRF token on every write, and refetches it once on `csrf.invalid`.
- `checkout.submitPayment()` resolves to the server's result, `paymentStatus` follows the server, and
  `checkout.markConfirmed()` is new.
- `client.customer.addresses` and `client.customer.orders` call the account routes.
- **Breaking:** `productList.setSort(key)` takes a `ProductSortKey`.
