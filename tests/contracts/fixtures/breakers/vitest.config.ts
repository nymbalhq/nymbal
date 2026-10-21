import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The breakers run (tests/contracts/contract-breakers.test.ts spawns it): each `*.breaker.ts` runs a published suite on
// an in-memory adapter, a correct one or its twin with one defect. Outside every project of the root config on
// purpose: a broken adapter failing is the point, and is read from this run's JSON report, never from the gate.

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.breaker.ts'],
    environment: 'node',
  },
})
