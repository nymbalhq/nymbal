import { createKernel } from '../support/kernel.js'
import { orderListFilterSuite } from '../support/suites/order-list-filter.js'

// The admin order list's filters and count on SQLite, each describe on a kernel of its own.

orderListFilterSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
