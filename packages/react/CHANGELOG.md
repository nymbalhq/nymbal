# @nymbalhq/react

## 1.5.0

### Patch Changes

- d0b44ed: Storefront client bundles are about 30 bytes smaller (the document-order collator is made on first use), and the
  web components and React wrappers build to the same bytes every time.
- Updated dependencies [f05e635]
- Updated dependencies [0b51500]
- Updated dependencies [965b85a]
- Updated dependencies [c778b26]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
- Updated dependencies [439c2aa]
  - @nymbalhq/types@1.5.0
  - @nymbalhq/sdk@1.5.0
  - @nymbalhq/web-components@1.5.0

## 1.4.0

### Minor Changes

- 295dab6: `<nymbal-notify-me>` (`NotifyMe` in `@nymbalhq/react`) shows the selected variant's back-in-stock form while it is out of stock; the SDK adds `client.adapter.alerts.subscribe()`.
  Breaking for a custom `CommerceAdapter`: add `alerts.subscribe({ email, variantId, kind })`.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

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
  - @nymbalhq/web-components@1.4.0
  - @nymbalhq/sdk@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/sdk@1.3.0
  - @nymbalhq/web-components@1.3.0

## 1.2.0

- Generated wrappers for every new element, from checkout and the cart page to the header, footer and grids; every
  wrapper takes a `slot` prop.
- Wrappers are generated from each element's schema, and `check:generated` fails when `wrappers.tsx` drifts from it.
- `@nymbalhq/react/server`: `renderNymbal(tag, attributes, children)` renders an element on the server for a wrapper's
  `serverHtml`.
- Each wrapper imports only its own element, so a page bundles what it renders.

## 1.1.0

- `ProductFilter source="search"` filters search results by category.
- The `nymbal-add-to-cart` wrapper takes `qty`; `PaymentElement` and `SortDropdown` are new.
- **Breaking:** the `nymbal-variant-selector` wrapper loses its `options` prop: options come from the product's
  variants.

## 1.0.0

- Versioned with the other packages; no changes of its own.

## 0.2.0

- First release under `@nymbalhq`.
- **Breaking:** needs React 19: the peer range is `>=19`, and the generated JSX declarations augment `react`.
