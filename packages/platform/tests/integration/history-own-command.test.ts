import { createKernel } from '../support/kernel.js'
import { historyOwnCommandSuite } from '../support/suites/history-own-command.js'

// A record's history names each event's own command and actor, on SQLite.

historyOwnCommandSuite('sqlite', {
  open: () => createKernel({ dialect: 'sqlite' }),
  propertyRuns: 4,
})
