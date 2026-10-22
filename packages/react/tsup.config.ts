import { defineConfig } from 'tsup'

export default defineConfig({
  // Each wrapper, the context and each hook is an entry of its own, so the root only re-exports: a bundler keeps what a
  // route imports and leaves out the rest, and a wrapper it leaves out takes its element with it.
  entry: ['src/index.ts', 'src/context.tsx', 'src/hooks/*.ts', 'src/generated/wrappers/*.tsx'],
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['react', 'react-dom', '@nymbalhq/sdk', '@nymbalhq/web-components', '@nymbalhq/types'],
})
