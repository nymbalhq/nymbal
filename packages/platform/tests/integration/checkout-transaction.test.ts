import { createKernel } from '../support/kernel.js'
import { checkoutTransactionSuite } from '../support/suites/checkout-transaction.js'

// AC-6, AC-10 and AC-11 on SQLite.

checkoutTransactionSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), {
  thousandPendingOrders: true,
})
