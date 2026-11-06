import { defineConfig } from 'vitest/config'

// Used only by Stryker (stryker.config.mjs): the Vitest runner cannot pick one project out of the workspace
// config, so this mirrors the platform-unit project and the importers' mapper tests.
export default defineConfig({
  test: {
    name: 'platform-unit',
    environment: 'node',
    // A fixed fast-check seed, so a property test kills the same mutants on every run.
    setupFiles: ['vitest.stryker.setup.ts'],
    include: [
      'packages/platform/src/**/*.test.ts',
      'packages/importers/tests/mappers/**/*.test.ts',
    ],
    exclude: ['packages/platform/tests/**'],
  },
})
