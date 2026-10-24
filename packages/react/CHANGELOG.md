# @nymbalhq/react

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
