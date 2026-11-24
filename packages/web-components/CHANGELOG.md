# @nymbalhq/web-components

## 1.10.0

### Minor Changes

- 64b219c: Breaking: an address's country must be an ISO 3166-1 two-letter code (`UK`, `United Kingdom` and `GBR` are refused; use `GB`), and a US region a state's code or name; the config refuses a non-ISO country in `store.shipFrom`, tax and shipping rates.
  The address form picks the country, and a US state, from a list.
- 8b16c14: Shoppers enter discount codes on the cart page and in the checkout summary, and see the discount and the total they will be charged before the address; ACP sessions take `discounts.codes` (or `coupons`) and answer `discounts`, MCP agents get `cart_addCode` and `cart_removeCode`, and UCP checkouts total the cart's discount.
  Breaking: `CommerceAdapter.cart` methods resolve `ShopperCart` and it gains required `addCode` and `removeCode`; `CartState` gains `totals`, `promotions` and `errorCode`; the elements' `cart` projection needs `discountTotalMinor`, `totalMinor` and `codes` (the templates' `fetchCart` fills them).
  ACP sessions now carry `discounts` and `capabilities.extensions`; `POST /api/cart/codes` refuses `.` and `..`.
  A store already scaffolded copies `src/lib/api.ts` (Astro) or `lib/api.ts` (Next.js) from the new template.
- ce6de60: The profile page lists the devices a shopper is signed in on (`nymbal-session-list`, `SessionList`), and each can be signed out, or every one at once; signing out now ends only that browser's session, and the release signs nobody out.
  Breaking: a custom `CommerceAdapter` must implement `customers.listSessions`, `endSession` and `endAllSessions`.

### Patch Changes

- e948f4e: `nymbal-add-to-cart` shows why an add was refused in a new `error` part and no longer fires `nymbal:cart:item-added` for it, so the cart drawer stays closed.
  Templates: the Next.js footer's About column is text instead of links to pages the template lacks, the Astro account navigation wraps at phone width, and the guest order page leaves out an empty timeline.
- 7e965d7: `nymbal-notify-me` tells the shopper to check the address if nothing arrives, and takes a corrected address in the same form without a reload.
- Updated dependencies [64b219c]
- Updated dependencies [ebf8ea0]
- Updated dependencies [6e82231]
- Updated dependencies [d64b5ed]
- Updated dependencies [689edc3]
- Updated dependencies [452299f]
- Updated dependencies [14246b8]
- Updated dependencies [8b16c14]
- Updated dependencies [7e6ec0c]
- Updated dependencies [660a7a9]
- Updated dependencies [f5bfc9a]
- Updated dependencies [8efbf8d]
- Updated dependencies [924fe84]
- Updated dependencies [b598c5c]
- Updated dependencies [09d8bff]
- Updated dependencies [da9c72b]
- Updated dependencies [84cecf1]
- Updated dependencies [ce6de60]
  - @nymbalhq/types@1.10.0
  - @nymbalhq/sdk@1.10.0

## 1.9.0

### Minor Changes

- 6822798: Shoppers can reset a forgotten password by email (`/account/forgot-password`) and change it on `/account/profile`, which signs out every other session; one account's failed sign-ins are refused past ten times the login limit until a reset.
  Breaking: `security.auth.accessTtl` must be 1m to 1h and `refreshTtl` longer than it, or the store refuses to start, naming the field.
  Per-address rate limits now count an IPv6 client by its /64, where before each full address was its own bucket.
- 6ce7da1: Breaking: on a store with an email provider, `POST /api/auth/register` answers 202 "check your email" for every address and signs nobody in until the mailed link (`/account/verify-email`) is followed; `security.auth.verification: 'off'` keeps the old behaviour, and a `native` store is `off` by default.
  Support can send the link again or mark the email confirmed from the customer's admin page; `nymbal doctor` and the admin dashboard warn when sign-ups are not confirmed or mail may not be arriving.
  Until an address is confirmed, a later register for it replaces the waiting account's password; its owner can still set their own with Forgot password.
  A store scaffolded before this release needs the template's `/account/verify-email` page before it adds an email provider, or the mailed link lands on a missing page.
- f7ad028: `commerce.shipping.rates` sets flat delivery options per country (optional `freeOverMinor`); `POST /api/checkout/quote` (MCP `checkout_quote`) prices the cart with shipping and tax, the checkout element and ACP show it and send `shippingOptionId` and `expectedTotalMinor`, and a checkout charging shipping or tax on top with no `expectedTotalMinor` is refused.
  Tax rows gain `taxShipping` (default `true`): a store that zero-rates goods through `codes` still taxes delivery at the row's percent unless the row sets `taxShipping: false`.
  Breaking: the SDK drops `setShippingMethod` and `ShippingMethod`; use `quote()` and `selectShippingOption(id)` (`useCheckout()`: `requestQuote` and `selectShippingOption`), and the state's `quote` and `quoting`.
- 4ad006f: Checkout charges tax from `commerce.tax.rates` (a row per country or US state, optional per-code rates; `onUnavailable: 'refuse' | 'native'`), and `store.pricesIncludeTax: true` extracts it from prices, shown as "Tax (included)"; a store with no rates is unchanged.
  Tax added on top of prices is charged only when `POST /api/checkout` sends the taxed total as `expectedTotalMinor`; the checkout element and agent checkouts do not send it yet, so they are refused on such a store.
  Breaking for a `custom` tax adapter: `calculate` is replaced by `capabilities()` and `quote()` (optional `commit` and `refund`); run `runTaxContract` from `@nymbalhq/contract-tests` against it.
- 4097e20: `dist/kit.js` puts a cart on a WordPress theme with one script tag and two meta tags, and a set-up that cannot work says why in the console. `POST /api/alerts/subscribe` accepts `linkOrigin`, held to `http.cors.allowedOrigins` and the new `http.cors.kitOrigins` (a site listed there gets CORS on the cart's routes alone), and `createNymbalClient` an `alertLinkOrigin`, so alert links reach the store.

### Patch Changes

- Updated dependencies [86aed8e]
- Updated dependencies [6822798]
- Updated dependencies [b74f305]
- Updated dependencies [c9bb448]
- Updated dependencies [d29f7e1]
- Updated dependencies [6ce7da1]
- Updated dependencies [f7ad028]
- Updated dependencies [5a71306]
- Updated dependencies [4ad006f]
- Updated dependencies [4097e20]
  - @nymbalhq/types@1.9.0
  - @nymbalhq/sdk@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [5b51750]
- Updated dependencies [70380e7]
- Updated dependencies [3991ca5]
  - @nymbalhq/types@1.8.0
  - @nymbalhq/sdk@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [071e340]
  - @nymbalhq/types@1.7.0
  - @nymbalhq/sdk@1.7.0

## 1.6.0

### Minor Changes

- 454e12a: `<nymbal-checkout>` refuses an order that needs payment when the page has no payment element, and asks a shopper whose session ended to sign in again (`sign-in-href`, default `/account/login?redirect=%2Fcheckout`).
- ec1e87b: Breaking for new stores: both storefront templates send a content security policy (`pagePolicy` in `lib/page-policy`), which refuses framing the store, http images and any third-party script, font, pixel, browser-side call or form target (analytics, chat, Google Fonts) until you add it there. `nymbal start` adds HSTS (https only), `nosniff`, `X-Frame-Options`, a `Referrer-Policy` and a minimal policy to any page that sets none.
  The shopper's access token now stays in page memory: `client.auth.restore()` brings the session back from the refresh cookie on each page load, guests send nothing, and requests made meanwhile wait for it. A token an earlier version left in `localStorage` is removed and its shopper stays signed in.
  A client built on `@nymbalhq/sdk/core`, as the Astro template's is, calls `resumeSession(client)` from `@nymbalhq/sdk/core` once per page load before its first request; a store that keeps its own older `lib/client.ts` must add it.
- 13a6b2d: Product listings, search, recently viewed and `GET /api/products/:slug` serve each product's `rating` (`{ average, count }`, or null with no approved review) from the reviews adapter; the native aggregate now counts every approved review. Product cards show the stars, average and count, `nymbal-review-list` takes a `rating` for its summary, and the product page's JSON-LD carries `aggregateRating`.
  A scaffolded store copies `src/lib/seo.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js, whose JSON-LD `url` now names `/product/<slug>`).
- f2c9a19: Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
  Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
- ac55979: With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
  Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
  The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.

### Patch Changes

- 0f751fe: A page the browser restores on Back reloads the mini-cart's count and unlocks a sign-in, register or Astro alert form that locked as it left. Text typed into a server-rendered form field before its element upgrades stays in the field.
- 7a136c9: `nymbal-cart-page` links a line to its product page by slug; a line stored without one shows its name unlinked.
- 7a4c608: Escape closes the open cart drawer. On a phone the header's mini-cart sits beside the menu toggle instead of inside the menu, in a new `cart` part. The product filter skips a facet with no values. An element your project defines before `registerClient` now follows its stores once the client registers. The server keeps quoted CSS strings in an element's styles exactly as written.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
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
- Updated dependencies [7a136c9]
- Updated dependencies [2be0e86]
- Updated dependencies [2fbb296]
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
  - @nymbalhq/sdk@1.6.0

## 1.5.0

### Minor Changes

- c778b26: Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
  or asks for a new link. Signed-in shoppers go to their account's order page.

  Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
  makes every field the confirmation page does not show optional.

### Patch Changes

- d0b44ed: Storefront client bundles are about 30 bytes smaller (the document-order collator is made on first use), and the
  web components and React wrappers build to the same bytes every time.
- 439c2aa: The storefront client can be built from `@nymbalhq/sdk/core` plus the `@nymbalhq/sdk/ns/*` namespaces a page uses; the
  Astro template does so. A store's own element that reads `client.cart`, `client.checkout` or another store namespace
  imports its `@nymbalhq/sdk/ns/<name>` module.
- Updated dependencies [f05e635]
- Updated dependencies [0b51500]
- Updated dependencies [965b85a]
- Updated dependencies [c778b26]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
- Updated dependencies [439c2aa]
  - @nymbalhq/types@1.5.0
  - @nymbalhq/sdk@1.5.0

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
