import { createKernel } from '../support/kernel.js'
import { QUIET_RELAY } from '../support/report-rebuild.js'
import { reportRebuildSuite } from '../support/suites/report-rebuild.js'

reportRebuildSuite('sqlite', () => createKernel({ dialect: 'sqlite', appOptions: QUIET_RELAY }), 20)
