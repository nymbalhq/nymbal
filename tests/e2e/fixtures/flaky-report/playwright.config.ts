import { tmpdir } from 'node:os'
import { defineConfig } from '@playwright/test'
import { e2eReporters } from '../../support/reporters'

// The fixture run behind tests/tooling/e2e-flaky-report.test.ts: the suite's reporters as a CI run has them, one
// retry, and the report directory the test chooses.
export default defineConfig({
  testDir: '.',
  testMatch: /flaky-once\.pw\.ts$/,
  retries: 1,
  workers: 1,
  reporter: e2eReporters(true, 'fixture', process.env.NYMBAL_FIXTURE_REPORTS ?? tmpdir()),
})
