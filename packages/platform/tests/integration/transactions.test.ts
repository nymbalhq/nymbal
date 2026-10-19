import { createKernel } from '../support/kernel.js'
import { transactionsSuite } from '../support/suites/transactions.js'

// P1-02 AC-4 and AC-9 on SQLite.

transactionsSuite('AC-4', 'sqlite', () => createKernel({ dialect: 'sqlite' }))
