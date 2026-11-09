import { createKernel } from '../support/kernel.js'
import { promotionRaceSuite } from '../support/suites/promotion-race.js'

// AC-20 on SQLite. The Postgres run is promotion-race.postgres.test.ts.

promotionRaceSuite(() => createKernel({ dialect: 'sqlite' }))
