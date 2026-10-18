import { createKernel } from '../support/kernel.js'
import { outboxSuite } from '../support/suites/outbox.js'

// P1-03 AC-4 and AC-5 on SQLite: events are appended in the publishing transaction and every committed row is
// delivered exactly once under concurrency.

outboxSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { propertyRuns: 10 })
