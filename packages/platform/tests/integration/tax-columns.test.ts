import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taxColumnsSuite } from '../support/suites/tax-columns.js'

// AC-23 on a SQLite file per test.

taxColumnsSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tax-columns-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
