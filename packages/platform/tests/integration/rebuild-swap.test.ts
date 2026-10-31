import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { rebuildSwapSuite } from '../support/suites/rebuild-swap.js'

// On a SQLite file with the in-memory document store. The Postgres run, on postgres-jsonb, is in integration-postgres
// (packages/platform/tests/postgres/rebuild-swap.postgres.test.ts).

rebuildSwapSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-swap-'))
    const kernel = await createKernel({ dialect: 'sqlite', sqlitePath: join(dir, 'store.sqlite') })
    return {
      kernel,
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { runs: 8 },
)
