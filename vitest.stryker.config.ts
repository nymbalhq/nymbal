import { defineConfig } from 'vitest/config'

// Used only by Stryker (stryker.config.mjs): the Vitest runner cannot pick one project out of the workspace
// config, so this mirrors the platform-unit project.
export default defineConfig({
  test: {
    name: 'platform-unit',
    environment: 'node',
    include: ['packages/platform/src/**/*.test.ts'],
    exclude: ['packages/platform/tests/**'],
  },
})
