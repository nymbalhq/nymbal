// This store's own elements. Everything here runs before any Nymbal element is defined (components/client/
// NymbalSetup.tsx imports it first), and Nymbal leaves alone any tag that is already defined, so an element defined
// here under a Nymbal tag replaces Nymbal's. The module is also evaluated on the server, so define elements only in
// the browser:
//
//   import { MyMiniCart } from './my-mini-cart'
//   if (typeof window !== 'undefined') customElements.define('nymbal-mini-cart', MyMiniCart)
export {}
