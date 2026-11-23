import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refundLineSuite } from '../support/suites/refund-line.js'

// A refund names its order line, on a SQLite file.

refundLineSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-refund-line-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
