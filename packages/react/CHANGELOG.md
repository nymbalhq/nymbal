# @nymbalhq/react

## 1.8.0

### Patch Changes

- Updated dependencies [5b51750]
- Updated dependencies [70380e7]
- Updated dependencies [3991ca5]
  - @nymbalhq/types@1.8.0
  - @nymbalhq/sdk@1.8.0
  - @nymbalhq/web-components@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [071e340]
  - @nymbalhq/types@1.7.0
  - @nymbalhq/sdk@1.7.0
  - @nymbalhq/web-components@1.7.0

## 1.6.0

### Minor Changes

- 13a6b2d: Product listings, search, recently viewed and `GET /api/products/:slug` serve each product's `rating` (`{ average, count }`, or null with no approved review) from the reviews adapter; the native aggregate now counts every approved review. Product cards show the stars, average and count, `nymbal-review-list` takes a `rating` for its summary, and the product page's JSON-LD carries `aggregateRating`.
  A scaffolded store copies `src/lib/seo.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js, whose JSON-LD `url` now names `/product/<slug>`).

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- 97133bc: A wrapped element no longer renders its default state first: it has its attributes (`qty`, `client`, `cart`) when it connects, even when the element was already defined.
- Updated dependencies [0700627]
- Updated dependencies [37d8f4a]
- Updated dependencies [86ad196]
- Updated dependencies [00c2f07]
- Updated dependencies [7cb17f1]
- Updated dependencies [5d95ad2]
- Updated dependencies [5240c52]
- Updated dependencies [d441055]
- Updated dependencies [061bc68]
- Updated dependencies [12e3285]
- Updated dependencies [9d42cd4]
- Updated dependencies [0f751fe]
- Updated dependencies [7a136c9]
- Updated dependencies [7a136c9]
- Updated dependencies [7a4c608]
- Updated dependencies [2be0e86]
- Updated dependencies [2fbb296]
- Updated dependencies [454e12a]
- Updated dependencies [454e12a]
- Updated dependencies [c9fe50b]
- Updated dependencies [853d563]
- Updated dependencies [ec1e87b]
- Updated dependencies [c52ac10]
- Updated dependencies [13a6b2d]
- Updated dependencies [f2c9a19]
- Updated dependencies [ac55979]
- Updated dependencies [07ff236]
- Updated dependencies [402a5d1]
- Updated dependencies [1a5b417]
  - @nymbalhq/types@1.6.0
  - @nymbalhq/web-components@1.6.0
  - @nymbalhq/sdk@1.6.0

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
