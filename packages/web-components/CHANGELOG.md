# @nymbalhq/web-components

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
