// Mutation testing of the platform services and repositories and of the WooCommerce importer's mappers. Run with
// `pnpm mutation`.
//
// Stryker runs in a sandbox under .stryker-tmp, never in place: in-place mode writes through symlinks in the
// checkout and its restore replaces them with copies. The sandbox holds only what the platform unit tests and the
// importer's mapper tests need, and is deleted after the run together with the per-worker setup files the Vitest
// runner writes into it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.config.ts' },
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: [
    'packages/platform/src/services/**/*.ts',
    'packages/platform/src/repositories/**/*.ts',
    // Measured by the integration run too (stryker.integration.config.mjs); here by the unit tests beside them.
    'packages/platform/src/events/relay.ts',
    'packages/platform/src/events/publisher.ts',
    'packages/importers/src/woocommerce/mappers/**/*.ts',
    // No unit test reaches these: stryker.integration.config.mjs measures them, and the services' composition root is
    // wiring every integration test runs through. Here they would score 0 and only cost time.
    '!packages/platform/src/services/alert-service.ts',
    '!packages/platform/src/services/description.ts',
    '!packages/platform/src/services/import-removal-service.ts',
    '!packages/platform/src/services/index.ts',
    '!packages/platform/src/services/proposal-service.ts',
    '!packages/platform/src/services/recently-viewed-service.ts',
    '!packages/platform/src/repositories/alert-subscription.ts',
    '!packages/platform/src/repositories/email-suppression.ts',
    '!packages/platform/src/repositories/proposal.ts',
    '!packages/platform/src/repositories/review.ts',
    '!**/*.test.ts',
    '!**/*.d.ts',
    // Type tests (`expectTypeOf`): tsc checks them, nothing runs them, so every mutant would survive.
    '!**/*.test-d.ts',
  ],
  // An allowlist: every root entry is left out except the platform, importers and types packages and the root configs
  // they build with. The importers' tests stay in: its mapper tests read the recorded stores under them. Workspace
  // dependencies resolve through the node_modules links Stryker adds to the sandbox.
  ignorePatterns: [
    '/*',
    '!/package.json',
    '!/tsconfig*.json',
    '!/vitest.stryker.config.ts',
    '!/vitest.stryker.setup.ts',
    '!/packages',
    '/packages/*',
    '!/packages/platform',
    '/packages/platform/dist',
    '/packages/platform/tests',
    '!/packages/importers',
    '/packages/importers/dist',
    '!/packages/types',
    '/packages/types/dist',
    '**/CLAUDE.md',
  ],
  disableTypeChecks: 'packages/platform/src/{services,repositories}/**/*.ts',
  coverageAnalysis: 'perTest',
  // A static mutant (module-level code, or a factory every test's setup calls) reruns the whole suite with a reload, last
  // in the run, against an allowance shorter than the suite's cold start: those reruns were most of the run's tail,
  // 46 of a nightly's 133 minutes. Only pure static mutants are skipped; one a test also reaches runs against it.
  ignoreStatic: true,
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
