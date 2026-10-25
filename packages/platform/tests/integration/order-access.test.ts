import { createKernel } from '../support/kernel.js'
import { orderAccessSuite } from '../support/suites/order-access.js'

// AC-2 on SQLite: each checkout answer's key reads its own order and no other.

orderAccessSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
