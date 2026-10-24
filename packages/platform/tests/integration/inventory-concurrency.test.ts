import { createKernel } from '../support/kernel.js'
import { inventoryConcurrencySuite } from '../support/suites/inventory-concurrency.js'

// AC-3, AC-13 and AC-16 on SQLite.

inventoryConcurrencySuite('sqlite', () => createKernel({ dialect: 'sqlite' }), {
  propertyRuns: 50,
})
