// Lets an element take over the shadow root a server rendered instead of rendering a second one. `lit-element` reads
// the hook this installs once, when it evaluates, so this module is the first import of every entry and of
// base-element: ESM evaluates imports depth-first in source order, and every component imports `lit` first.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js'
