import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moneyMigrationSuite } from '../support/suites/money-migration.js'

// P1-13 AC-8 on a SQLite file.

moneyMigrationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-13-money-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
