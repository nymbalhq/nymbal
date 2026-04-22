import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/db/schema/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: [
    '@nymbal/types',
    '@nymbal/config',
    'better-sqlite3',
    'drizzle-orm',
    'pg',
    'pino',
    'pino-pretty',
  ],
})
