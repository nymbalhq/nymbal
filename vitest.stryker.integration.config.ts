import { defineConfig } from 'vitest/config'

// Used only by Stryker (stryker.integration.config.mjs): the platform-integration project narrowed to the test families
// that reach the files that config mutates. Prefix globs take in a new test of a family with no change here; the
// tests that spawn processes or import from outside the sandbox (adapter-graph, capabilities-route) stay out. The unit
// tests beside the relay and the publisher are in too: they reach what no store-level test can (the outage probe's
// bounds, start and stop, the bus wrapper, a correlated publisher).
export default defineConfig({
  test: {
    name: 'platform-integration',
    environment: 'node',
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
      'packages/platform/src/events/*.test.ts',
    ],
    testTimeout: 30000,
  },
})
