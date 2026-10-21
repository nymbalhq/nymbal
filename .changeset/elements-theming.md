---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

A store can restyle and replace every Nymbal element without forking the package.

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
