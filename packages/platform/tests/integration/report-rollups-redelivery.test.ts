import { createKernel } from '../support/kernel.js'
import { reportRollupRedeliverySuite } from '../support/suites/report-rollups-redelivery.js'

reportRollupRedeliverySuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
