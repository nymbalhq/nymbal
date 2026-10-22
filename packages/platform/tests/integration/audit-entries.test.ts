import { createKernel } from '../support/kernel.js'
import { auditEntriesSuite } from '../support/suites/audit-entries.js'

// P3-04 AC-2 on SQLite (spec P3-04-audit-trail): a kernel from `src/`, served over HTTP.

auditEntriesSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 10 })
