import { defineConfig } from 'tsup'

// The index is the whole client; `core` and each `ns/<module>` let a page bundle only the stores it reads. Splitting
// keeps each store's code in one file that every entry reaching it shares.
// Splitting also moves each `ns` module's registration into a shared chunk, which is why package.json's
// `sideEffects` names `dist/chunk-*.js` beside `dist/ns/*.js`: a bundler would otherwise drop the registration.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'ns/cart': 'src/ns/cart.ts',
    'ns/product': 'src/ns/product.ts',
    'ns/product-list': 'src/ns/product-list.ts',
    'ns/search': 'src/ns/search.ts',
    'ns/checkout': 'src/ns/checkout.ts',
    'ns/auth': 'src/ns/auth.ts',
  },
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['@nymbalhq/types'],
})
