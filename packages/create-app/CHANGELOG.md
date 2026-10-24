# create-nymbal-app

## 0.4.0

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

- 9136ecd: A store picks its read model and its event bus from what is built. `infrastructure.documentStore` is `in-memory`,
  `redis` or `postgres-jsonb`; `infrastructure.eventBus` is `in-process` or `redis-streams`. Each non-native choice is its
  own package, which the kernel imports only when the config names it: `@nymbalhq/doc-store-redis` (with `ioredis`),
  `@nymbalhq/doc-store-postgres-jsonb` (with `pg`) and `@nymbalhq/event-bus-redis-streams` (with `ioredis`). A missing
  package fails `createApp` with `adapter.package_missing` and the install line, as the provider adapters do.
  - The Redis store and bus share an optional `infrastructure.redis` block: `url` (default `REDIS_URL`), `prefix`
    (default `NYMBAL_REDIS_PREFIX`, then `nymbal`; it namespaces every key and stream), and the bus's `ackTimeoutMs`
    (15 000), `claimIdleMs` (5 000) and `streamMaxLen` (10 000). A Redis store or bus with no URL fails at `createApp`.
  - `postgres-jsonb` needs `commandStore: 'postgres'` and uses its connection (`DATABASE_URL`). It creates and owns one
    table, `nymbal_documents`, at start.
  - `redis-streams` needs a shared document store (`redis` or `postgres-jsonb`): a named subscription is one consumer
    group across instances, so an in-memory read model would miss the events another instance handled.
  - On every bus, `publish` resolves only after every matching handler has finished, so a read straight after a command
    sees its projection. Delivery is at least once, so handlers must be idempotent. A subscription with a `name` is
    handled once per name across instances; one without is handled by every subscriber on every instance (the admin's
    live stream now subscribes without a name, so every open tab gets every event).
  - `infrastructure.media` is new, with one value, `local-fs` (the default). `app.platform.media` is the instance, and
    `app.capabilities().media` reports its own `capabilities()`.

  **Breaking: the infrastructure config lists only what is built.**
  - `infrastructure.cloud` and `infrastructure.compute` are removed: they drove nothing. A config that still sets either
    fails `loadConfig` saying the key was removed and should be deleted. Delete both lines.
  - `documentStore: 'dynamodb' | 'firestore' | 'cosmosdb'` and `eventBus: 'eventbridge' | 'pubsub' | 'service-bus'`, which
    only threw "planned for v1.0" at start, are removed. Any value a slot does not list, and any key `infrastructure` does
    not know, now fails `loadConfig` naming the slot's values or the known keys (`KNOWN_INFRASTRUCTURE`, exported by
    `@nymbalhq/config`).
  - The refusal of `security.adapter: 'middleware'` on `cloud: aws | gcp | azure` went with `cloud`.

  **Breaking for code that builds the platform itself.** `createPlatform(config, options)` takes the primitives as
  instances: `{ documentStore, eventBus, media }` beside `sqlitePath`, `postgresUrl` and `logger`. `resolvePrimitives(config)`
  builds them from the config, and `createApp` does both. `createDocumentStore` and `createEventBus` are gone.
  `MediaStorage` now lives in `@nymbalhq/types` (`@nymbalhq/platform` still re-exports it). `@nymbalhq/types` adds
  `compareDocumentValues`, `matchesSortKey` and `queryDocuments`, the order and filter every document store is held to:
  values of different types rank by type (numbers, strings, other types, then null and missing), so `1` and `'1'` no
  longer compare as equal both ways, and nulls sort last in either direction. A `query` cursor now seeks by position
  without an `orderBy` too, so a document deleted between pages no longer restarts the walk. `AdapterContext.slot` is a
  `Slot`: the commerce slots plus `documentStore`, `eventBus` and `media`.

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

## 0.3.0

### Minor Changes

- 6571ce9: Provider SDKs leave the kernel. `@nymbalhq/platform` no longer depends on `stripe`, `@anthropic-ai/sdk` or
  `nodemailer`: each lives in its own package, `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and
  `@nymbalhq/adapter-smtp`, which the kernel imports only when `nymbal.config.ts` names its provider. A store that uses
  one installs it and its SDK (`npm install @nymbalhq/adapter-stripe stripe`); if it is missing, `createApp` fails with
  `adapter.package_missing` and prints that line for the package manager in use.

  **Breaking: the config only accepts providers it knows.** Each commerce slot's `provider` is now one of
  `KNOWN_PROVIDERS` (exported by `@nymbalhq/config`): payments `native` or `stripe`; email `native` (console) or `smtp`;
  ai `none` or `anthropic`; reviews, search, analytics, shipping and tax `native`; and `custom` for every slot. Any other
  string, which used to load and silently run the native stub, now fails `loadConfig` naming the slot and the providers
  it accepts. In particular:
  - `ai: { provider: 'native' }` is no longer accepted: use `ai: { provider: 'none' }`, which builds no AI adapter
    (`app.adapters.ai` is `null`, and the admin's AI route answers 503).
  - SMTP mail moves from `email: { provider: 'native', config: { transport: 'smtp', smtp } }` to
    `email: { provider: 'smtp', config: { smtp } }` plus `@nymbalhq/adapter-smtp` and `nodemailer`. The old form fails
    `loadConfig` instead of printing mail to the console.
  - The Anthropic key is read from `ai.config.apiKey`, falling back to `ANTHROPIC_API_KEY`.

  **`createApp(config, { adapters })`** takes a project's own adapter for any slot whose provider is `custom`. A `custom`
  slot with nothing injected, or an adapter injected for a slot that is not `custom`, fails with
  `adapter.custom_mismatch`. `nymbal dev` and `nymbal start` cannot inject adapters yet. In production the stub-payments
  refusal reads the resolved adapter, so an injected stub is refused and an injected real adapter starts.

  **Capabilities.** `capabilities` is now a method, `capabilities(): readonly string[]`, on every adapter, the document
  store, the event bus and `MediaStorage`; adapters written against the old `capabilities` array must become a function.
  `app.capabilities()` reports each slot's provider and its adapter's answer. The native payments stub no longer lists
  `webhook`, since it verifies no signature.

  The kernel no longer exports `createStripePaymentsAdapter` or `createAnthropicAiAdapter` (import them from the adapter
  packages), and `createNativeEmailAdapter` keeps only the console transport. A new project's config defaults ai to
  `none`, so a fresh store installs no provider SDK. The WooCommerce importer skips AI enrichment when the store has no
  AI provider.

### Patch Changes

- bda781a: Astro storefront forms submit once. Add address, profile save, login, register, place order and the review form go
  through `submitOnce(form, handler)` (`src/lib/submit-once.ts`), which ignores a submit while the previous one is in
  flight, so a double click or a second Enter makes one change (a double-clicked Save on the add-address form used to
  create two addresses). The button is disabled while the handler runs and re-enabled when it settles, unless the
  handler resolves `'leaving'` after setting `location.href`; a handler that throws or rejects releases the form. The
  profile and review handlers move from inline `<script>`s to `src/scripts/profile-form.ts` and
  `src/scripts/review-form.ts`.
- ebbfeec: The admin and the Astro account pages fit a phone. Below the `md` breakpoint (768 px) the admin sidebar is off-canvas:
  a menu button in the top bar (`data-testid="admin-nav-toggle"`, `aria-expanded`) opens it over the page, and choosing
  a link or tapping the backdrop closes it; `main` and the top bar drop their 240 px offset and the live ticker is
  hidden. The dashboard, order detail, product edit, customer profile and media grids stack on narrow screens. At `md`
  and up the admin is unchanged. The Astro account sidebar no longer widens the page on a phone (468 px at 412): its
  link row scrolls inside the column.

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 26fd94a: A checkout that completes. `POST /api/checkout` now answers the payment outcome (`payment: { status: 'succeeded' |
'requires_action' | 'failed', reason? }` and `orderStatus`). When the payments adapter captures at once, as the
  `native-stub` adapter now does, the order is confirmed, its stock committed and its cart emptied in the same request;
  Stripe orders are still confirmed by the webhook. The stub takes test triggers from the receipt email: a local part
  ending `+stub-pending` stays pending, `+stub-decline` fails. One cart has at most one pending order (migration `0005`,
  `orders.cart_token` with a partial unique index): a resubmit answers the same order, a changed cart cancels the old
  intent and supersedes its order (409 `checkout.payment_in_progress` when the provider refuses), an emptied cart
  answers 409 `checkout.cart_empty` naming the order it became, and a pending order left without an intent is
  abandoned after 120 s. A capture for a cancelled order, or one that cannot confirm its order, is refunded. The
  `order-placed` email is sent once per order on `order.paid`, not on `order.placed`, so an unpaid or imported order
  sends none.

  `PaymentsAdapter` gains `cancelPaymentIntent(intentId)` and `getPaymentIntent(intentId)`, and
  `PaymentIntentParams.receiptEmail`; a third-party adapter must implement both methods. In the SDK,
  `checkout.submitPayment()` resolves to the server's result (or `null`), `paymentStatus` is `succeeded` only when the
  server says so and `requires_action` while Stripe must confirm, `checkout.markConfirmed()` is new, and the cart store
  reloads after a submit. Both templates follow `payment.status`, and their order pages show the order's real state
  ("Awaiting payment" for a pending order).

- 22b4523: Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
  seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
  `pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
  payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
  project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
  tells the storefront to skip Stripe unless the configured provider is `stripe`.
- 07d451c: Sort works. `GET /api/products?sort=` takes `newest` (the default), `price-asc`, `price-desc`, `name-asc` or `name-desc`, ties broken by slug; an unknown key, or a cursor from another sort, answers 400. Breaking in the SDK: `productList.setSort(key)` takes a `ProductSortKey` instead of `(field, direction)`, `state.sort` is that key. `load(params)` defines the listing: its `sort` and `category` become the active ones, and a `load(params)` without `sort` resets the sort to `newest`; `load()` with no arguments reloads the current sort and category, and `setSort` and `loadMore` keep them. A response that arrives after a newer request is dropped. `QueryParams.orderBy` orders a document-store query without filtering it. Both templates offer the same five sorts, keep them in `?sort=`, and render that order on the server. Category facet counts on `GET /api/products` now always count the whole catalogue.
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

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
