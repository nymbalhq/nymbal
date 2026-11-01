import { createKernel } from '../support/kernel.js'
import { adminCancelStockSuite } from '../support/suites/admin-cancel-stock.js'

// AC-1 and AC-3 on SQLite.

adminCancelStockSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 12 })
