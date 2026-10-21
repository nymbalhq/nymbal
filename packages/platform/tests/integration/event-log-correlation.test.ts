import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventLogCorrelationSuite } from '../support/suites/event-log-correlation.js'

// P3-01 AC-5 and the platform half of AC-6 on SQLite (spec P3-01-event-log-surface): a file per database.

eventLogCorrelationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-01-log-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
