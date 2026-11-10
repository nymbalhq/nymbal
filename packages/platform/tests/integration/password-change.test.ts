import { createKernel } from '../support/kernel.js'
import { passwordChangeSuite } from '../support/suites/password-change.js'

// "Change password" on SQLite: sessions ended and renewed, refusals that change nothing, the race with a refresh in
// flight, and who may change whose password (AC-18 to AC-21).

passwordChangeSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 6,
})
