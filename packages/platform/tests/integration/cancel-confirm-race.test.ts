import { createKernel } from '../support/kernel.js'
import { cancelConfirmRaceSuite } from '../support/suites/cancel-confirm-race.js'

// P1-13 diff review B2 on a SQLite file (writers take turns on the store's queue: the confirm parks behind the cancel).

cancelConfirmRaceSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
