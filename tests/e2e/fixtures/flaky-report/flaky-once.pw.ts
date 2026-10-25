import { expect, test } from '@playwright/test'

// A test that fails on its first attempt and passes on the retry: with retries on, the run is green and only the
// JSON report's `flaky` status tells.
test('passes only on a retry', ({}, testInfo) => {
  expect(testInfo.retry, 'the first attempt fails, the retry passes').toBeGreaterThanOrEqual(1)
})

test('passes first time', ({}, testInfo) => {
  expect(testInfo.retry).toBe(0)
})
