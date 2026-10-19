import { createKernel } from '../support/kernel.js'
import { singleOrderSuite } from '../support/suites/single-order.js'

// P1-12 AC-3 on SQLite: one cart, one order, whatever the shopper or the network does.

singleOrderSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
