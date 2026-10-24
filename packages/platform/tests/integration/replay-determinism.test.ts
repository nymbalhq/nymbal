import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { replayDeterminismSuite } from '../support/suites/replay-determinism.js'

// P3-02 AC-2 on SQLite (spec P3-02-replay-engine): a fresh SQLite file per property run. The Postgres run is in
// integration-postgres (packages/platform/tests/postgres/replay-determinism.postgres.test.ts).

replayDeterminismSuite('sqlite', {
  runs: 8,
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'p3-02-determinism-'))
    const kernel = await createKernel({ dialect: 'sqlite', sqlitePath: join(dir, 'store.sqlite') })
    return {
      kernel,
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
