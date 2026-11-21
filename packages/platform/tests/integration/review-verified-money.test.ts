import { createKernel } from '../support/kernel.js'
import { reviewVerifiedMoneySuite } from '../support/suites/review-verified-money.js'

// A verified review and the order's money, on SQLite.

reviewVerifiedMoneySuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 25 })
