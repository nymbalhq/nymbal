import { createKernel } from '../support/kernel.js'
import { adminProductsSearchSuite } from '../support/suites/admin-products-search.js'

// The admin products search on SQLite.

adminProductsSearchSuite('sqlite', {
  open: () => createKernel({ dialect: 'sqlite' }),
  propertyRuns: 6,
})
