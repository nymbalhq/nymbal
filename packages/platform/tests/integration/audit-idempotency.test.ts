import { createKernel } from '../support/kernel.js'
import { idempotencySuite } from '../support/suites/audit-idempotency.js'

// AC-1 on SQLite: a kernel from `src/`, served over HTTP.

idempotencySuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 12 })
