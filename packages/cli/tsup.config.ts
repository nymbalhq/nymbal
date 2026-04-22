import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: [
    '@nymbal/types',
    '@nymbal/config',
    '@nymbal/http',
    '@nymbal/platform',
    'citty',
    'picocolors',
  ],
})
