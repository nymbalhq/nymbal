import { createKernel } from '../support/kernel.js'
import { unconfirmedAccountsSuite } from '../support/suites/unconfirmed-accounts.js'

// The purge of never-confirmed accounts on SQLite: who is removed and who never is, what a removal leaves behind, once
// across ticks and replicas, a register after it, the mail funnel's seven days, and a pass that outlives one failure.

unconfirmedAccountsSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 20,
})
