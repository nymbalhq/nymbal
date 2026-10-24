import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/race.ts',
    'src/chaos.ts',
    'src/mail.ts',
    'src/payments.ts',
    'src/store.ts',
    'src/arbitraries.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
})
