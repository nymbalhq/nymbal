import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { searchBackfillSuite } from '../support/suites/search-backfill.js'

// AC-6 on SQLite: two kernels, one after the other, on one file. The Postgres run is in integration-postgres
// (packages/platform/tests/postgres/search-backfill.postgres.test.ts).

searchBackfillSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-backfill-'))
  const sqlitePath = join(dir, 'store.sqlite')
  return {
    open: () => createKernel({ dialect: 'sqlite', sqlitePath }),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
