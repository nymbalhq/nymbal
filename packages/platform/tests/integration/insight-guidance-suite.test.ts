import { createKernel } from '../support/kernel.js'
import { insightGuidanceSuite } from '../support/suites/insight-guidance.js'

insightGuidanceSuite('sqlite', (opts) => createKernel({ dialect: 'sqlite', ...opts }))
