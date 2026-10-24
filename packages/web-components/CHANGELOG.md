# @nymbalhq/web-components

## 1.2.0

### Minor Changes

- 757150c: Checkout is now a Nymbal element, `nymbal-checkout`, so a store can restyle or replace it like the cart page.
  - **The element:** the contact, shipping and payment steps (billing sits in the payment step), the step indicator, the
    error and the order summary, in an open shadow root. Its `parts` and `slots` are listed in its schema. The shipping
    and billing addresses are `nymbal-address-form` elements.
  - **Payment:** the page puts `<nymbal-payment-element slot="payment">` inside `nymbal-checkout`. The payment element
    stays in the light DOM and mounts its driver once, whichever step the shopper is on. Place Order is disabled while
    the payment element reports `error`.
  - **Event:** `nymbal:checkout:placed` (`{ orderNumber }`) fires after the checkout store is reset. The page decides
    where to go next. `@nymbalhq/react` has a generated `Checkout` wrapper with `onPlaced`, and it passes its children
    through.
  - **Behaviour, the same on both templates:**
    - A billing address that differs from shipping reaches the order. On Astro it used to throw.
    - A double click on Continue moves one step and submits nothing on the next step.
    - Place Order sends one order request per press.
  - **Templates:** the Astro and Next.js checkout pages now render the element. Billing test ids are `billing-*` on both
    templates. Removed: Astro's `scripts/checkout.ts`, `AddressForm.astro`, `CheckoutSteps.astro` and
    `styles/pages/checkout.css`, and Next's `CheckoutForm.tsx`, `CheckoutSteps.tsx` and `checkout.module.css`.
  - **Fixes:**
    - Every generated React wrapper takes a `slot` prop.
    - `nymbal-payment-element` no longer throws when its `client` changes after its first render.

- 68d2358: The cart page, the search results and the account forms are now Nymbal elements, so a store can restyle or replace
  them like the other elements.
  - **New elements:** `nymbal-cart-page`, `nymbal-product-card`, `nymbal-search-results`, `nymbal-login-form`,
    `nymbal-register-form`, `nymbal-profile-form`, `nymbal-address-form` and `nymbal-address-book`. Each renders in an
    open shadow root, reads the `--nymbal-*` tokens, and lists its `parts` and `slots` in its schema. `@nymbalhq/react`
    has a generated wrapper for each one.
  - **Events:**
    - `nymbal:auth:signed-in`, from login and register. The page decides where to go next.
    - `nymbal:profile:saved`.
    - `nymbal:address-book:changed`.
  - **Behaviour:**
    - The cart page shows the cart's `subtotalMinor` from the API.
    - Register asks for the password twice.
    - Login and register keep the submit disabled after success, through the redirect.
    - Pressing Enter in an address field saves the address.
  - **Templates:** both render the elements in place of their own cart, search-results and account-form code, so a new
    project carries about 1,700 fewer template lines.

- 5b89c81: The storefronts' server-rendered components are now Nymbal elements, so a store themes them like every other
  element and a project override replaces them.
  - **Eleven new elements:** `nymbal-product-grid` (`products`, `source="product-list"`, `has-more`, `lazy`),
    `nymbal-product-price` and `nymbal-stock-badge` (`product-id`, following the product store's selected variant
    once it settles on that product), `nymbal-breadcrumb`, `nymbal-image-gallery`, `nymbal-site-header` (the search
    bar and mini-cart as slotted children), `nymbal-site-footer`, `nymbal-category-nav`, `nymbal-review-list`,
    `nymbal-review-form` (one submit per click; any non-2xx answer shows the error and re-enables submit) and
    `nymbal-order-summary` (`subtotal`, `discount`, `shipping`, `tax` parts). All render on the server through the
    `ssr` entry and hydrate without re-rendering.
  - **`nymbal-product-card`** gains `eager` (the image is `loading="eager" fetchpriority="high"`: a grid's first four
    cards) and renders the from-price when a product carries a price range. `cardProductOf` and `cardImageOf` are
    exported for pages that ship cards.
  - **Soft navigation on Next:** every element anchor dispatches a cancelable `nymbal:navigate` (`{ href }`); the
    template's `NymbalSetup` routes it through the App Router.
  - **React wrappers** for the eleven elements; `@nymbalhq/sdk`'s product-list store reports `loading: true` as its
    first update, so a server-rendered grid keeps its cards until the store settles.
  - **Templates:** the home, listing, category, product, order and layout views render the elements from the pages'
    data; the old components, their CSS modules and the client re-renderers are gone (Astro −1,066 lines, Next −786).
    The product page's gallery image is the page's one high-priority image, preloaded from the head, as is each grid
    page's first card. The Astro template gzips its HTML in `src/middleware.ts` when the client accepts it.

- a05b2e4: Nymbal elements are now rendered on the server, as declarative shadow DOM. With JavaScript off, the cart, checkout,
  search results, header cart count, product options and account forms are on the page. With JavaScript on, each element
  takes over the markup it was given instead of rendering it again.
  - **`@nymbalhq/web-components/ssr`** (Node only): `renderElement(tag, { attributes, children })` returns the element
    with its first render inside `<template shadowrootmode="open">`, then the light-DOM `children`.
    `registerServerElements({ tag: Class })` makes the server render a store's own class under a Nymbal tag.
    `nymbal-payment-element` stays client-mounted.
  - **`@nymbalhq/web-components/astro`:** `<NymbalElement tag attributes>` renders an element in an Astro page. The slot
    becomes its light DOM.
  - **`@nymbalhq/react/server`:** `renderNymbal(tag, attributes, children)` returns `{ __html }`. A server component passes
    it to the generated wrapper as `serverHtml`, and the wrapper renders it on its own tag. A wrapper takes either
    `serverHtml` or `children`. `NymbalServer` renders one element in a page with no client view.
  - **`@nymbalhq/web-components/hydrate-support`:** a store's own Lit element imports it before `lit`. Every Nymbal
    module already imports it first.
  - **Elements render from server data.** New attributes: `cart` on `nymbal-cart-page`, `nymbal-checkout` and
    `nymbal-cart-drawer` (lines, subtotal, currency and item count; never the cart token), `count` on
    `nymbal-mini-cart`, `results` and `query` on `nymbal-search-results`, `product` on `nymbal-variant-selector`,
    `customer` on `nymbal-profile-form` and `addresses` on `nymbal-address-book`. `nymbal-product-filter` with
    `source="search"` shows its `facets` attribute. A value given this way shows until the element's store first answers.
    Without a registered client, an element renders from its attributes and calls nothing.
  - **React wrappers** now put every attribute in their JSX, so a page rendered on the server ships the attributes.
  - **Templates:** both read the shopper's cart with the request's `nymbal.cart` cookie, and only when the cookie is
    there. `elements/index.ts` exports `serverElements`. Next's `NymbalSetup` starts loading the cart before it defines
    the layout's elements. The `:not(:defined)` space reservations for the cart page and checkout are gone.

- 2d5ee9c: A store can restyle and replace every Nymbal element without forking the package.
  - **Lit, in a shadow root.** The ten elements are Lit 3 elements (`lit` is a new dependency). Each renders in an open
    shadow root, except `nymbal-payment-element`, which stays in the light DOM so the payment driver's UI and the
    checkout form share one tree. They read their look from the `--nymbal-*` custom properties, and each falls back to
    the package's `tokens.css` value. Their pieces carry `part`s, so you can style them with `::part()`, for example
    `nymbal-add-to-cart::part(button)`. Their labels and empty states are named `slot`s, with the current text as the
    fallback. Each element's `parts` and `slots` are listed in its schema.
  - **Breaking:**
    - `injectStyles` is removed. Elements no longer put `<style>` tags into `document.head`.
    - Selectors that reached inside an element (`nymbal-mini-cart button`, `.nymbal-cart-item`, and the like) no
      longer match. Use `::part()` instead.
    - `nymbal-cart-drawer`'s `open()` and `close()` methods are now `show()` and `hide()`. The `open` attribute and
      property say whether the drawer is open, and `toggle()` is unchanged.
    - `nymbal-sort-dropdown` loses its `value` getter. Its `value` property is the `value` attribute, and the change
      event carries the chosen key.
  - **Search layout:** `nymbal-product-filter` carries an `empty` attribute while it shows no facet. The Astro search
    page lays out on `nymbal-product-filter[empty]`, because `:empty` always matches a shadow host.
  - **The sort dropdown with a server-rendered `<select>`:** `nymbal-sort-dropdown` slots a `<select>` child, fills it
    and wires it, so the sort works before JavaScript loads. With no such child, it renders its own `part="select"`.
  - **Schemas:** each element class has a `static schema` (`ElementSchema`, exported), which lists its tag, attributes,
    events, parts and slots. Its Lit properties come from the schema.
  - **React wrappers:** `@nymbalhq/react` generates its wrappers from those schemas. `scripts/generate-wrappers.ts`
    exports `generateWrappers(schemas)`, and `check:generated` now fails when `wrappers.tsx` differs from what the
    schemas generate. A new attribute on an element reaches its wrapper with no manual edit.
  - **New projects own their tokens and elements.** Each template has its own tokens file, which its global CSS
    imports in place of the package's: `src/styles/tokens.css` in Astro, `app/tokens.css` in Next. Each template also
    has an empty elements entry, imported before `registerComponents()`: `src/elements/index.ts` in Astro,
    `elements/index.ts` in Next. An element you define there under a Nymbal tag replaces Nymbal's, because
    `registerComponents()` skips any tag that is already defined.

- 94fcffd: Every page loads only the elements it renders, and the templates carry performance budgets.
  - **Per-element entry points:** `@nymbalhq/web-components/elements/<tag>` exports one element with a static
    `define()`; the package has no import-time side effects (`sideEffects: ["*.css"]`), so a bundler drops what a page
    does not import. `registerComponents()` still defines everything for a page that wants that. Payment drivers
    register in the payment element's `beforeDefine`, not at import.
  - **React:** `@nymbalhq/react`'s root is a facade of pure re-exports; each generated wrapper defines its own element
    in an effect and imports its element's entry point, so Turbopack and webpack tree-shake per page. `NymbalSetup`
    defines the layout's elements.
  - **Templates:** each Astro page's module script and each Next route define exactly what they render; the checkout
    page reserves `nymbal-checkout`'s box before it upgrades, so the footer stays put (CLS 0.68 → 0.01).
  - **Budgets:** `pnpm perf:budgets` measures LCP, CLS, TBT and script bytes on the home, listing, product, cart and
    checkout pages of both templates against `perf-budgets.json` (whole-KiB script budgets at the measured value + 5%;
    the Next cart keeps a 3000 ms LCP exception until server rendering); it refuses ports something else listens on. CI
    runs it, and the production E2E that proves per-page loading, in the `perf-budgets` job.
  - **Fixes:** Astro listing images are no longer lazy above the fold (LCP); the Next filter panel is not rendered on
    phones (CLS); the Next cart no longer shifts after hydration.

### Patch Changes

- eaa120c: `nymbal-mini-cart` renders no text node for an empty badge. Before, a hydrated mini-cart whose server HTML had an
  empty badge kept it empty after a soft navigation, though the cart had items.
- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [5b89c81]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0
  - @nymbalhq/sdk@1.2.0

## 1.1.0

### Minor Changes

- f93dab3: The `native` search provider is full-text search in the store's own database: SQLite FTS5 on a SQLite store, a
  GIN-indexed `tsvector` on Postgres. Every match is reachable through cursor pages with an exact total.
  - Migration 0007 creates the search tables (`search_documents`, and on SQLite its FTS5 index). Run
    `nymbal migrate`. A store that had products before 0007 indexes them on its next start, from the warm-up replay.
  - `createNativeSearchAdapter({ sql, logger })` takes the command store's raw clients (`rawClients(store)`), not a
    document store. `BuildAdaptersDeps` takes `sql` in place of `documentStore`. The `search-index` document-store
    collection is no longer written.
  - Results are ranked: products with every query term in the name come first, then products with every term in the
    name, a SKU or a variant name, then the rest by the engine's score, then by id.
  - `search` pages by `cursor`. `nextCursor` is null on the last page, and `total` counts every match. A malformed
    cursor is an error, and a cursor past the last match is an empty last page. `encodeSearchCursor(offset)` is
    exported. `filters.categoryIds` narrows to a category, with filters applied as well as the query.
  - `FacetParams.query` is new: `facet('categoryIds', { query, filters })` counts the query's matches per category.
  - `GET /api/products/search` takes `category=<slug>` and answers `{ items, nextCursor, total, facets }`. `facets` is
    the category facet in the listing's shape (slug values, name labels) when search reports `facet` and the query
    matches. An unknown category gives no items and a total of 0. A malformed cursor is a 400.
  - The SDK's `products.search(query, { limit, cursor, category })` returns `total` and `facets`. The search store
    gains `loadMore()` and `setCategory(slug | null)`, and `SearchState` gains `category`, `nextCursor` and `facets`.
    Its `total` is now the API's total, not the number of results loaded. `useSearch` exposes the same.
  - `<nymbal-product-filter source="search">` (React: `ProductFilter source="search"`) renders the search's facets and
    narrows the search to the category chosen. Choosing the chosen category again clears it.
  - Both templates' `/search` show the API's total (`search-total`), a Load more button (`search-load-more`) while
    pages remain, and the category filter when the search has facets. The filter writes `?category=` beside `?q`.

  **Behaviour change in matching.** A query is split into terms: runs of ASCII letters and digits, lowercased.
  Everything else separates terms, and that includes non-ASCII letters. Each term must be a prefix of a word in the
  product's name, SKU, variant name or description. The old match was a substring anywhere in the product. So
  `ool` no longer finds "wool", `foo.bar` finds products with words starting `foo` and `bar`, a query with no terms
  finds nothing, and a match in a field other than these four (a slug, a price) no longer counts.

- 6f72118: The product page adds the quantity and the variant the shopper picks, the same way on both templates.
  - `@nymbalhq/types` exports the one stock rule, `stockLevel(stock)` (`'out'` at 0 or below, `'low'` below 5, else
    `'in'`), and `STOCK_LABELS`. Both PDP badges render from it, with `data-level` on `stock-badge`. Add-to-cart is
    disabled exactly when the selected variant's stock is 0 or below, and a product with no variants is out of stock.
  - `<nymbal-add-to-cart qty>` (React: `qty`) adds that many units: a whole number clamped to 1-99, and anything else
    is 1. `nymbal:cart:item-added` carries `{ variantId, qty }`.
  - Both PDPs wire a `<nymbal-quantity-selector>` to add-to-cart, and the quantity starts again at 1 when the variant
    changes. `<nymbal-quantity-selector>` shows and emits a whole number: a typed or set value is truncated toward zero
    and clamped to `min`-`max`, and anything that is not a number is `min`, so a typed 2.7 shows and adds 2. Astro's
    `/cart` steps each line with `<nymbal-quantity-selector>`, as Next does. On both templates, decrement stops at 1 and
    the line's `cart-remove-<variantId>` button removes it.
  - The product read model always serves `variants[].options` as `VariantOption[]`, including for products projected
    from older events that stored the options as a JSON string.

  **Breaking.** `<nymbal-variant-selector>` takes variant options as `VariantOption[]` only. Its `options` attribute
  (React: the `options` prop) is gone, so the selector reads its groups from the product's variants alone. On Astro's
  `/cart`, decrement at 1 no longer removes the line. Next's unused `components/server/StockBadge.tsx` is removed.

- ea74a39: The storefronts render from what the store's adapters can do, never from which vendor is configured.
  - `GET /api/capabilities` (public) answers the store's report: `payments` (`capabilities`, `client`), `search`
    (`capabilities`) and `catalog` (`sortKeys`, `defaultSort`). It names no provider and serves no secret.
    `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS` are new in `@nymbalhq/types`. The SDK reads the
    report once per client with `client.capabilities.get()`.
  - A payments adapter may describe its storefront half with `client(): { driver, options } | null`, where `options`
    holds public values only. The native stub answers `{ driver: 'test-mode', options: {} }`. Stripe answers
    `{ driver: 'stripe', options: { publishableKey } }`, from the new `publishableKey` in its config or
    `STRIPE_PUBLISHABLE_KEY`; a key that starts `sk_` or `rk_` there fails at start.
  - `<nymbal-payment-element client='<json>'>` (React: `PaymentElement`) renders that client half through a driver
    from the SDK's registry (`registerPaymentDriver(name, driver)`, `getPaymentDriver(name)`), and its
    `confirm(clientSecret, context?)` answers `{ ok: true, confirmed }` or `{ ok: false, error }`. `context`
    (`PaymentConfirmContext`: `email`, `billing`) is the shopper's email and billing address, which both checkouts
    pass and the `stripe` driver sends as `billing_details`. `registerComponents()`
    registers the `test-mode` driver and a `stripe` driver that loads Stripe.js from js.stripe.com, so no project
    installs a Stripe package. A project registers a driver of its own in its client bootstrap; one registered under a
    built-in's name wins. A `null` client renders nothing; an unknown driver shows `payment-element-error`, and the
    checkout keeps Place Order disabled.
  - `<nymbal-sort-dropdown sort-keys value default-sort>` (React: `SortDropdown`) offers the store's sort keys in its
    order and emits `nymbal:sort:changed` with `{ sort }`.
  - Astro's listing script sorts on the dropdown's `nymbal:sort:changed`, so it sorts whichever select the element
    renders. On Astro's checkout, the second click of a double click on shipping Continue, which lands on Place Order,
    no longer places the order.
  - `GET /api/products` leaves out `facets` when the search adapter does not report `facet`. Both templates render the
    product filter only from the listing's facets, the header search bar only when search reports `search`, and the sort
    options from `catalog.sortKeys`.
  - `loadConfig()` returns the config module's named `adapters` export as `adapters`, and `nymbal dev` passes it to
    `createApp`, so a `custom` slot runs under `nymbal dev`.

  **Breaking for a Stripe store and for a scaffolded checkout.** The templates no longer import `@stripe/*`, read
  `PUBLIC_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` or `*_NYMBAL_PAYMENTS_PROVIDER`, and
  `nymbal dev` no longer sets the latter. Give the API the publishable key instead (`payments.config.publishableKey`
  or `STRIPE_PUBLISHABLE_KEY`). The payment step's test id is `payment-element` (was `stripe-card-element` on Astro and
  `card-element` on Next), and Next's `CheckoutForm` takes the report as its `capabilities` prop.

### Patch Changes

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [ea74a39]
  - @nymbalhq/types@1.1.0
  - @nymbalhq/sdk@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [6571ce9]
  - @nymbalhq/types@1.0.0
  - @nymbalhq/sdk@1.0.0

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 07d451c: Sort works. `GET /api/products?sort=` takes `newest` (the default), `price-asc`, `price-desc`, `name-asc` or `name-desc`, ties broken by slug; an unknown key, or a cursor from another sort, answers 400. Breaking in the SDK: `productList.setSort(key)` takes a `ProductSortKey` instead of `(field, direction)`, `state.sort` is that key. `load(params)` defines the listing: its `sort` and `category` become the active ones, and a `load(params)` without `sort` resets the sort to `newest`; `load()` with no arguments reloads the current sort and category, and `setSort` and `loadMore` keep them. A response that arrives after a newer request is dropped. `QueryParams.orderBy` orders a document-store query without filtering it. Both templates offer the same five sorts, keep them in `?sort=`, and render that order on the server. Category facet counts on `GET /api/products` now always count the whole catalogue.

### Patch Changes

- e29919d: Honest storefront templates.
  - **SDK.** `client.customer.addresses.{list,create,remove}` and `client.customer.orders.{list,get}` call the account
    routes that exist, with the bearer token and the envelope unwrapped.
  - **Account pages.** Both templates' account pages now use these SDK calls, so a signed-in shopper sees their
    profile, addresses and orders. An order opens by its order number.
  - **Next.js template.** Sign Out revokes the session, a reload keeps a signed-in shopper signed in, and the account
    area can add an address.
  - **Search.** Choosing a search suggestion, by click or keyboard, opens the product on both templates.
  - **Upgrades.** The templates move to Astro 7 and Next 16 with React 19.
    - `@nymbalhq/react` now targets React 19 types: its peer range is `>=19`, and the generated JSX declarations augment
      `react` rather than the global namespace. That is breaking for React 18 consumers (pre-1.0, so a minor).
    - `nymbal dev` passes `--ignore-lock` to `astro dev`, so Astro 7 stays in the foreground when an AI agent runs it.
  - **Typecheck.** The root typecheck now runs `astro check`, and the scaffold is re-synced.
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [ccd3d36]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e29919d]
- Updated dependencies [e90bf2d]
  - @nymbalhq/types@0.2.0
  - @nymbalhq/sdk@0.2.0
