// This store's own elements. Everything here runs before any Nymbal element is defined (components/client/
// NymbalSetup.tsx imports it first), and Nymbal leaves alone any tag that is already defined, so an element defined
// here under a Nymbal tag replaces Nymbal's. The server renders Nymbal's elements too, so a replacement is also named
// in `serverElements`, and the server renders it under the tag (lib/render.ts). The module is evaluated on the server
// as well, so define elements only in the browser, and import @nymbalhq/web-components/hydrate-support before lit,
// so the element takes over what the server rendered:
//
//   import '@nymbalhq/web-components/hydrate-support'
//   import { MyMiniCart } from './my-mini-cart'
//   if (typeof window !== 'undefined') customElements.define('nymbal-mini-cart', MyMiniCart)
//   export const serverElements = { 'nymbal-mini-cart': MyMiniCart }
export const serverElements = {}
