import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionsMigrationSuite } from '../support/suites/sessions-migration.js'

// The session columns' migration on a SQLite file per test.

sessionsMigrationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-migration-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
