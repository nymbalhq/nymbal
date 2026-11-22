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
    // The sandbox leaves out packages/platform/tests (stryker.config.mjs), so the unit tests below, which import its
    // support modules or fixtures, cannot load there, and a test file that cannot load fails Stryker's initial run.
    exclude: [
      'packages/platform/tests/**',
      'packages/platform/src/agents/acp/discounts.test.ts',
      'packages/platform/src/agents/agent-cart-source.test.ts',
      'packages/platform/src/agents/readiness.test.ts',
      'packages/platform/src/agents/ucp-surface.test.ts',
      'packages/platform/src/agents/ucp-tools.test.ts',
      'packages/platform/src/assistant/loop.bulk.test.ts',
      'packages/platform/src/assistant/loop.date.test.ts',
      'packages/platform/src/assistant/loop.mask.test.ts',
      'packages/platform/src/assistant/loop.records.test.ts',
      'packages/platform/src/assistant/loop.summary.test.ts',
      'packages/platform/src/assistant/loop.taint.test.ts',
      'packages/platform/src/assistant/stamp.test.ts',
      'packages/platform/src/assistant/summary.test.ts',
      'packages/platform/src/mcp/invoke.meta.test.ts',
      'packages/platform/src/mcp/invoke.test.ts',
      'packages/platform/src/mcp/registry.test.ts',
      'packages/platform/src/routes/password-routes.tools.test.ts',
      'packages/platform/src/routes/schemas.test.ts',
      'packages/platform/src/routes/schemas.tools.test.ts',
      'packages/platform/src/routes/verification-routes.tools.test.ts',
      'packages/platform/src/settings/crypto.test.ts',
    ],
  },
})
