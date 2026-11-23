import { createKernel } from '../support/kernel.js'
import { nightShiftSuite } from '../support/suites/night-shift.js'
import { refundProductsSuite } from '../support/suites/refund-products.js'

nightShiftSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
refundProductsSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
