import { createKernel } from '../support/kernel.js'
import { reviewAggregateSuite } from '../support/suites/review-aggregate.js'

// The aggregate rating on SQLite: one SQL aggregate over the approved reviews, with no row limit.

reviewAggregateSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { propertyRuns: 30 })
