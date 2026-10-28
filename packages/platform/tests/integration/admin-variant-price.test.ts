import { createKernel } from '../support/kernel.js'
import { adminVariantPriceSuite } from '../support/suites/admin-variant-price.js'

// The admin's variant price edit on SQLite: saved, served and logged as one price event per real change.

adminVariantPriceSuite('sqlite', {
  open: () => createKernel({ dialect: 'sqlite' }),
  propertyRuns: 10,
})
