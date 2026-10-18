import { createKernel } from '../support/kernel.js'
import { underpaymentSuite } from '../support/suites/underpayment.js'

// P1-05 AC-3 on SQLite. Sentinel S007 names this file.

underpaymentSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), {
  serviceRuns: 8,
  httpRuns: 3,
})
