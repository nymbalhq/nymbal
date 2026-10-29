import { readdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

// tsup expands an entry array with an async glob whose order changes from run to run, and esbuild's shared chunks
// follow the entry order, so the same source built twice could ship different bytes. Named entries, sorted, do not.
const inDir = (dir: string, ext: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => `${dir}/${f}`)
const named = (files: string[]) =>
  Object.fromEntries(
    [...files].sort().map((f) => [f.replace(/^src\//, '').replace(/\.tsx?$/, ''), f]),
  )

export default defineConfig({
  // Each wrapper, the context and each hook is an entry of its own, so the root only re-exports: a bundler keeps what a
  // route imports and leaves out the rest, and a wrapper it leaves out takes its element with it.
  // The server renderer is an entry no client module imports (it loads Lit SSR).
  entry: named([
    'src/index.ts',
    'src/context.tsx',
    ...inDir('src/hooks', '.ts'),
    ...inDir('src/generated/wrappers', '.tsx'),
    'src/server.tsx',
  ]),
  format: ['esm'],
  splitting: true,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['react', 'react-dom', '@nymbalhq/sdk', '@nymbalhq/web-components', '@nymbalhq/types'],
})
