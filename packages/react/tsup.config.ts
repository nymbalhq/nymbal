import { defineConfig } from 'tsup'

export default defineConfig({
  // Each generated wrapper is an entry of its own, so it stays a module of its own: a bundle that leaves a wrapper
  // out leaves out the element it imports.
  entry: ['src/index.ts', 'src/generated/wrappers/*.tsx'],
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['react', 'react-dom', '@nymbalhq/sdk', '@nymbalhq/web-components', '@nymbalhq/types'],
})
