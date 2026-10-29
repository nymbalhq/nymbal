import { readdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

// tsup expands an entry array with an async glob whose order changes from run to run, and esbuild's shared chunks
// follow the entry order, so the same source built twice could ship different bytes. Named entries, sorted, do not.
const inDir = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f}`)
const named = (files: string[]) =>
  Object.fromEntries(
    [...files].sort().map((f) => [f.replace(/^src\//, '').replace(/\.tsx?$/, ''), f]),
  )

export default defineConfig({
  // One entry per element, and registerComponents (which reaches every element) in an entry of its own, so the root
  // only re-exports: a bundler that skips unused re-exports of a side-effect-free package then ships a page only the
  // elements it imports.
  // The hydrate support is an entry of its own (a store's override imports it before lit), and the server renderer
  // one that only Node loads.
  entry: named([
    'src/index.ts',
    'src/register-components.ts',
    ...inDir('src/elements'),
    'src/hydrate-support.ts',
    'src/ssr/index.ts',
  ]),
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['@nymbalhq/sdk', '@nymbalhq/types'],
  // The hydrate support must evaluate before lit-element does (src/hydrate-support.ts), but code splitting moves a
  // side-effect import below the chunk imports that reach lit. Every emitted module imports it first instead.
  banner: { js: "import '@lit-labs/ssr-client/lit-element-hydrate-support.js'" },
})
