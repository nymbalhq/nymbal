import { createKernel } from '../support/kernel.js'
import { orderAccessSuite } from '../support/suites/order-access.js'

// AC-6 on SQLite: each guest checkout answer’s key reads its own order and no other; a signed-in checkout answers no key.

orderAccessSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
