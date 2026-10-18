import { createKernel } from '../support/kernel.js'
import { webhookRaceSuite } from '../support/suites/webhook-race.js'

// P1-05 AC-12 on SQLite; Postgres is the required dialect and runs the same suite.

webhookRaceSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
