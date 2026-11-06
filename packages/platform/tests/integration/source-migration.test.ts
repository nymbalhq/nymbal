import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceMigrationSuite } from '../support/suites/source-migration.js'

// AC-5 on a SQLite file per test.

sourceMigrationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
