import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolesColumnSuite } from '../support/suites/roles-column.js'

// P1-06 AC-11 and AC-12 on a SQLite file per test.

rolesColumnSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-06-roles-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
