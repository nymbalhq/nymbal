# @nymbalhq/web-components

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
