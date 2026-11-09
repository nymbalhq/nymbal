import { defineConfig } from 'tsup'

// The one file a theme loads from a CDN: everything bundled, so a browser resolves no bare import. `clean` is off, as
// this runs after the package's own build and into the same directory.
export default defineConfig({
  entry: { kit: 'src/kit.ts' },
  format: ['esm'],
  splitting: false,
  platform: 'browser',
  noExternal: [/./],
  minify: true,
  target: 'es2022',
  clean: false,
  dts: false,
})
