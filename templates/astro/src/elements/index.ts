// This store's own elements. Everything here runs before any Nymbal element is defined (src/lib/client.ts runs it
// first, and every page script imports that), and Nymbal leaves alone any tag that is already defined, so an element
// defined here under a Nymbal tag replaces Nymbal's. The server renders Nymbal's elements too, so a replacement is
// also named in `serverElements`, and the server renders it under the tag (src/lib/server-elements.ts). Import
// @nymbalhq/web-components/hydrate-support before lit, so the element takes over what the server rendered:
//
//   import '@nymbalhq/web-components/hydrate-support'
//   import { MyMiniCart } from './my-mini-cart.js'
//   if (typeof window !== 'undefined') customElements.define('nymbal-mini-cart', MyMiniCart)
//   export const serverElements = { 'nymbal-mini-cart': MyMiniCart }
export const serverElements = {}
