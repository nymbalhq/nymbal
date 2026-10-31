import { createKernel } from '../support/kernel.js'
import { orderSequenceSuite } from '../support/suites/order-sequence.js'

// Order numbers on SQLite, each store a kernel on a temp file of its own.

orderSequenceSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
