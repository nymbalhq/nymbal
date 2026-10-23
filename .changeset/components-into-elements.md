---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/sdk': patch
'create-nymbal-app': minor
---

The storefronts' server-rendered components are now Nymbal elements, so a store themes them like every other
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
