import { defineConfig } from 'vitest/config'

// Used only by Stryker (stryker.integration.config.mjs): the platform-integration project narrowed to the test families
// that reach the files that config mutates. Prefix globs take in a new test of a family with no change here; the
// tests that spawn processes or import from outside the sandbox (adapter-graph, capabilities-route) stay out.
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
    ],
    testTimeout: 30000,
  },
})
