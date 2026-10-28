# @nymbalhq/web-components

## 1.4.0

### Minor Changes

- 295dab6: `<nymbal-notify-me>` (`NotifyMe` in `@nymbalhq/react`) shows the selected variant's back-in-stock form while it is out of stock; the SDK adds `client.adapter.alerts.subscribe()`.
  Breaking for a custom `CommerceAdapter`: add `alerts.subscribe({ email, variantId, kind })`.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [295dab6]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [75989c8]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0
  - @nymbalhq/sdk@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/sdk@1.3.0

## 1.2.0

- Elements are Lit elements in open shadow roots, styled through `--nymbal-*` tokens and `::part()`. **Breaking:**
  `injectStyles` is gone, selectors inside an element no longer match (use `::part()`), and the cart drawer's `open()`
  and `close()` are `show()` and `hide()`.
- New elements: `nymbal-checkout`, `nymbal-cart-page`, `nymbal-search-results`, the account forms, and the header,
  footer, grids, price, stock badge, gallery, breadcrumb, reviews and order summary.
- Elements render on the server as declarative shadow DOM (`@nymbalhq/web-components/ssr` and `/astro`), so pages work
  with JavaScript off. A store's own Lit element imports `@nymbalhq/web-components/hydrate-support` before `lit`.
- `@nymbalhq/web-components/elements/<tag>` loads one element, and the package has no import-time side effects.
- An element defined under a Nymbal tag before `registerComponents()` replaces Nymbal's, in the browser and, with
  `registerServerElements`, on the server.

## 1.1.0

- `<nymbal-product-filter source="search">` filters search results by category.
- `<nymbal-add-to-cart qty>` adds that many, and `<nymbal-quantity-selector>` shows whole numbers. **Breaking:**
  `<nymbal-variant-selector>` takes `VariantOption[]` only; its `options` attribute is gone.
- `<nymbal-payment-element>` and `<nymbal-sort-dropdown>` render from the store's capabilities.

## 1.0.0

- Versioned with the other packages; no changes of its own.

## 0.2.0

- First release under `@nymbalhq`.
- Choosing a search suggestion, by click or keyboard, opens the product.
