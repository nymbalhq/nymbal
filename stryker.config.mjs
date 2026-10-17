// Mutation testing of the platform services and repositories. Run with `pnpm mutation`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.config.ts' },
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: [
    'packages/platform/src/services/**/*.ts',
    'packages/platform/src/repositories/**/*.ts',
    '!**/*.test.ts',
    '!**/*.d.ts',
  ],
  // Stryker's sandbox copy fails on directory symlinks, and the tests read the tracked `migrations` symlink
  // (-> packages/platform/migrations) relative to the repo root, so mutate in place; Stryker restores the sources.
  inPlace: true,
  // Executable bins are ignored because the in-place backup restore drops their mode bits.
  ignorePatterns: ['.claude', 'coverage', 'reports', 'packages/*/bin'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
