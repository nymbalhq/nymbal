// Mutation testing of the kernel files whose behaviour only the platform integration tests reach, under those tests
// (SQLite). Run with `pnpm mutation:integration`; its scores are held by mutation-ratchet.integration.json, apart from
// the unit ratchet, since the unit run scores these files lower and would fail against an integration entry.
//
// The sandbox keeps every package: the integration tests import the Fastify adapter from packages/http/src. It keeps
// the repository's shared test servers too (tests/support): without them order-email-retry fails to load there and
// kills nothing. Every run is a full measurement, so there is no incremental file.
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
    'packages/platform/src/events/relay.ts',
    'packages/platform/src/events/publisher.ts',
    'packages/platform/src/repositories/processed-event.ts',
    'packages/platform/src/repositories/email-suppression.ts',
    'packages/platform/src/repositories/order-sequence.ts',
    'packages/platform/src/services/review-service.ts',
    'packages/platform/src/repositories/review.ts',
    'packages/platform/src/services/proposal-service.ts',
    'packages/platform/src/repositories/proposal.ts',
    'packages/platform/src/services/import-removal-service.ts',
    'packages/platform/src/services/description.ts',
    'packages/platform/src/repositories/audit-entry.ts',
    'packages/platform/src/repositories/report-rollup.ts',
    'packages/platform/src/repositories/password-reset-token.ts',
    'packages/platform/src/assistant/loop.ts',
    'packages/platform/src/assistant/mask.ts',
    'packages/platform/src/mcp/invoke.ts',
    'packages/platform/src/mcp/withhold.ts',
  ],
  ignorePatterns: [
    '/*',
    '!/package.json',
    '!/tsconfig*.json',
    '!/vitest.stryker.integration.config.ts',
    '!/vitest.stryker.setup.ts',
    '!/packages',
    '!/tests',
    '/tests/*',
    '!/tests/support',
    '/packages/*/dist',
    '/packages/adapters/*/*/dist',
    '**/CLAUDE.md',
  ],
  disableTypeChecks: 'packages/platform/src/{services,repositories,assistant,mcp}/**/*.ts',
  coverageAnalysis: 'perTest',
  // Static mutants are left out as in stryker.config.mjs: each reruns the whole suite with a reload, which is most of
  // the run's tail. Only pure static mutants are skipped; one a test also reaches runs against it.
  ignoreStatic: true,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation-integration/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation-integration/mutation.html' },
  incremental: false,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
