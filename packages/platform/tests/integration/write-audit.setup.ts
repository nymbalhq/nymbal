import { afterEach, expect } from 'vitest'
import { describeViolation, writeAuditViolations } from '../support/write-audit.js'

// Every platform-integration file runs under the write audit (tests/support/write-audit.ts, installed by the store
// openers in tests/support): a transaction that broke it fails the test it ran in, or the next one when it ran in a
// hook before it. The message names each transaction's tables, events and test, whatever the reporter shows of a diff.

afterEach(() => {
  const found = writeAuditViolations().map(describeViolation)
  expect(found, `committed transactions that broke the write audit:\n${found.join('\n')}`).toEqual(
    [],
  )
})
