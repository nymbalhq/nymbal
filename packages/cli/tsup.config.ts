import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: [
    '@nymbalhq/types',
    '@nymbalhq/config',
    '@nymbalhq/http',
    '@nymbalhq/platform',
    'citty',
    'picocolors',
  ],
})
