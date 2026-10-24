import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsRefusalsSuite } from '../support/suites/settings-refusals.js'

// AC-6 on a SQLite file per test.

settingsRefusalsSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-refusals-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
