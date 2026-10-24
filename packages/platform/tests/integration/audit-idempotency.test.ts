import { createKernel } from '../support/kernel.js'
import { idempotencySuite } from '../support/suites/audit-idempotency.js'

// P3-04 AC-1 on SQLite (spec P3-04-audit-trail): a kernel from `src/`, served over HTTP.

idempotencySuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 12 })
