---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

Nymbal elements are now rendered on the server, as declarative shadow DOM. With JavaScript off, the cart, checkout,
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
