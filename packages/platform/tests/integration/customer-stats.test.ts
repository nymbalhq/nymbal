import { createKernel } from '../support/kernel.js'
import { customerStatsSuite } from '../support/suites/customer-stats.js'

// A customer page's stats on SQLite, on a kernel of its own.

customerStatsSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
