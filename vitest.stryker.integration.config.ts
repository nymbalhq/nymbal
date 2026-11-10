import { defineConfig } from 'vitest/config'

// Used only by Stryker (stryker.integration.config.mjs): the platform-integration project narrowed to the test families
// that reach the files that config mutates. Prefix globs take in a new test of a family with no change here; the
// tests that spawn processes or import from outside the sandbox (adapter-graph, capabilities-route) stay out. The unit
// tests beside the relay and the publisher are in too: they reach what no store-level test can (the outage probe's
// bounds, start and stop, the bus wrapper, a correlated publisher); so is the proposal service's, for a settle that loses.
export default defineConfig({
  test: {
    name: 'platform-integration',
    environment: 'node',
    // A fixed fast-check seed, so a property test kills the same mutants on every run.
    setupFiles: ['vitest.stryker.setup.ts'],
    include: [
      'packages/platform/tests/integration/alerts*.test.ts',
      'packages/platform/tests/integration/recently-viewed-*.test.ts',
      'packages/platform/tests/integration/order-access*.test.ts',
      'packages/platform/tests/integration/order-key-*.test.ts',
      'packages/platform/tests/integration/order-sequence*.test.ts',
      'packages/platform/tests/integration/admin-variant-price.test.ts',
      'packages/platform/tests/integration/outbox*.test.ts',
      'packages/platform/tests/integration/event-retries*.test.ts',
      'packages/platform/tests/integration/order-email-retry*.test.ts',
      'packages/platform/tests/integration/email-feedback*.test.ts',
      'packages/platform/tests/integration/email-outage.test.ts',
      'packages/platform/tests/integration/event-retention*.test.ts',
      'packages/platform/tests/integration/review*.test.ts',
      'packages/platform/tests/integration/product-ratings*.test.ts',
      'packages/platform/tests/integration/proposals*.test.ts',
      'packages/platform/tests/integration/stuck-proposals*.test.ts',
      'packages/platform/tests/integration/import-removal-*.test.ts',
      'packages/platform/tests/integration/product-description*.test.ts',
      'packages/platform/tests/integration/audit-*.test.ts',
      'packages/platform/tests/integration/report-rollups*.test.ts',
      'packages/platform/tests/integration/admin-reports*.test.ts',
      'packages/platform/tests/integration/password-*.test.ts',
      'packages/platform/tests/integration/login-account-ceiling.test.ts',
      'packages/platform/src/events/*.test.ts',
      'packages/platform/src/services/proposal-service.test.ts',
      // The assistant's boundary: what its loop and the tool surface refuse, mask and keep for a person. The golden set's
      // own runs are left out (27 questions per test, a full run per mutant it reaches).
      'packages/platform/tests/integration/assistant-safety.test.ts',
      'packages/platform/tests/integration/assistant-guards.test.ts',
      'packages/platform/tests/integration/assistant-bulk.test.ts',
      'packages/platform/tests/integration/assistant-masking.test.ts',
      'packages/platform/src/assistant/loop*.test.ts',
      'packages/platform/src/assistant/mask.test.ts',
      'packages/platform/src/mcp/invoke*.test.ts',
      'packages/platform/src/mcp/withhold.test.ts',
      'packages/platform/src/repositories/email-suppression.test.ts',
    ],
    testTimeout: 30000,
  },
})
