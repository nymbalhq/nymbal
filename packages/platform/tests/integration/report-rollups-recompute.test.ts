import { createKernel } from '../support/kernel.js'
import { reportRollupSuite } from '../support/suites/report-rollups.js'

reportRollupSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), 25)
