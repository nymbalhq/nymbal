// This store's own elements. Everything here runs before any Nymbal element is defined (src/lib/client.ts runs it
// first, and every page script imports that), and Nymbal leaves alone any tag that is already defined, so an element
// defined here under a Nymbal tag replaces Nymbal's:
//
//   import { MyMiniCart } from './my-mini-cart.js'
//   customElements.define('nymbal-mini-cart', MyMiniCart)
export {}
