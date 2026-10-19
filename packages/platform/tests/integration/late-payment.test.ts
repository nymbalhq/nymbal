import { createKernel } from '../support/kernel.js'
import { latePaymentSuite } from '../support/suites/late-payment.js'

// P1-05 AC-11 on SQLite.

latePaymentSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
