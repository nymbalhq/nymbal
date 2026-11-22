import { createKernel } from '../support/kernel.js'
import { nightShiftSuite } from '../support/suites/night-shift.js'

nightShiftSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
