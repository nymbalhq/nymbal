import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { idempotencyRestartSuite } from '../support/suites/idempotency-restart.js'

// P1-03 AC-7 on SQLite: two kernels, one after the other, on one file. Replaces event-idempotency.test.ts (which built
// the document-store repository) and carries sentinel I104.

idempotencyRestartSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-03-idem-'))
  const sqlitePath = join(dir, 'store.sqlite')
  return {
    open: () => createKernel({ dialect: 'sqlite', sqlitePath }),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
