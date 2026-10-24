import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { replayCatchUpSuite } from '../support/suites/replay-catch-up.js'

// AC-3 on a SQLite file: case (b) and the failure report. The late lower-seq commit is Postgres only
// (packages/platform/tests/postgres/replay-catch-up.postgres.test.ts).

replayCatchUpSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-catch-up-'))
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
