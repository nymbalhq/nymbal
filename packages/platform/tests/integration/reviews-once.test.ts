import { createKernel } from '../support/kernel.js'
import { reviewsOnceSuite } from '../support/suites/reviews-once.js'

// AC-6 on SQLite, over HTTP on a served kernel: the check exists (SQLite runs one writer at a time, so the Postgres
// half is the one that proves the lock).

reviewsOnceSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { propertyRuns: 12 })
