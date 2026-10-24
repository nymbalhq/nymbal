import { createKernel } from '../support/kernel.js'
import { transactionsSuite } from '../support/suites/transactions.js'

// AC-4 and AC-9 on SQLite.

transactionsSuite('AC-4', 'sqlite', () => createKernel({ dialect: 'sqlite' }))
