import { createKernel } from '../support/kernel.js'
import { auditEntriesSuite } from '../support/suites/audit-entries.js'

// AC-2 on SQLite: a kernel from `src/`, served over HTTP.

auditEntriesSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 10 })
