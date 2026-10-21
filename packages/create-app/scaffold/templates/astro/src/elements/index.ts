// This store's own elements. Everything here runs before registerComponents() (src/lib/client.ts), and Nymbal
// leaves alone any tag that is already defined, so an element defined here under a Nymbal tag replaces Nymbal's:
//
//   import { MyMiniCart } from './my-mini-cart.js'
//   customElements.define('nymbal-mini-cart', MyMiniCart)
export {}
