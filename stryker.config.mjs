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
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
