import { createKernel } from '../support/kernel.js'
import { keylessOrdersSuite } from '../support/suites/order-access-migration.js'

// AC-3 on SQLite: orders with no key, old and imported, after the migration to the head.

keylessOrdersSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
