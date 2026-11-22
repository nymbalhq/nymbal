import { defineConfig } from 'tsup'

// The country and US state lists are entries of their own, so the address form reaches them without the index: a
// storefront page's bundle holds the index in a chunk every page loads. No splitting: a chunk shared with the index
// would be a module the index imports, which Turbopack places with the index, on every page; each entry inlines its
// own copy instead, and a bundler drops the index's copy where nothing reads it.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    countries: 'src/countries.ts',
    'us-states': 'src/us-states.ts',
  },
  format: ['esm'],
  splitting: false,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
})
