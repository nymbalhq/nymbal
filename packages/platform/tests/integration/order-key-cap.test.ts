import { createKernel } from '../support/kernel.js'
import { orderKeyCapSuite } from '../support/suites/order-key-cap.js'

// AC-5 on SQLite: an order keeps its newest checkout keys only.

orderKeyCapSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
