import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventLogCorrelationSuite } from '../support/suites/event-log-correlation.js'

// AC-5 and the platform half of AC-6 on SQLite: a file per database.

eventLogCorrelationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-log-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
