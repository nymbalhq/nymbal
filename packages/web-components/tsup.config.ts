import { defineConfig } from 'tsup'

export default defineConfig({
  // One entry per element, and registerComponents (which reaches every element) in an entry of its own, so the root
  // only re-exports: a bundler that skips unused re-exports of a side-effect-free package then ships a page only the
  // elements it imports.
  entry: ['src/index.ts', 'src/register-components.ts', 'src/elements/*.ts'],
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['@nymbalhq/sdk', '@nymbalhq/types'],
})
