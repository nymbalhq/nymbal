// Mutation testing of the kernel files whose behaviour only the platform integration tests reach, under those tests
// (SQLite). Run with `pnpm mutation:integration`; its scores are held by mutation-ratchet.integration.json, apart from
// the unit ratchet, since the unit run scores these files lower and would fail against an integration entry.
//
// The sandbox keeps every package: the integration tests import the Fastify adapter from packages/http/src. Every run
// is a full measurement, so there is no incremental file.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.integration.config.ts' },
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: [
    'packages/platform/src/services/alert-service.ts',
    'packages/platform/src/repositories/alert-subscription.ts',
    'packages/platform/src/services/recently-viewed-service.ts',
    'packages/platform/src/repositories/order-access-key.ts',
  ],
  ignorePatterns: [
    '/*',
    '!/package.json',
    '!/tsconfig*.json',
    '!/vitest.stryker.integration.config.ts',
    '!/packages',
    '/packages/*/dist',
    '**/CLAUDE.md',
  ],
  disableTypeChecks: 'packages/platform/src/{services,repositories}/**/*.ts',
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation-integration/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation-integration/mutation.html' },
  incremental: false,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
