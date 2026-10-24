# @nymbalhq/web-components

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
