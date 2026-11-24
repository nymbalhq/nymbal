import { createKernel } from '../support/kernel.js'
import { adminSearchRecordsSuite } from '../support/suites/admin-search-records.js'

// The admin global search over orders and customers on SQLite.

adminSearchRecordsSuite('sqlite', {
  open: () => createKernel({ dialect: 'sqlite' }),
})
