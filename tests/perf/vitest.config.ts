import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// AC-2 and AC-4: spawned runs of `pnpm perf:budgets` (production builds, a seeded API, Lighthouse, three runs a page),
// minutes each. They need Chrome and belong to the `perf-budgets` CI job, so no project of the root vitest.config.ts
// collects them and `pnpm test` and the gate never run them.
//
// Run: pnpm exec vitest run --config tests/perf/vitest.config.ts

export default defineConfig({
  test: {
    name: 'perf-budgets',
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['tests/perf/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 45 * 60_000,
  },
})
