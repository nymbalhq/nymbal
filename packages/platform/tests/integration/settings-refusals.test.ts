import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsRefusalsSuite } from '../support/suites/settings-refusals.js'

// P3-07 AC-6 on a SQLite file per test (spec P3-07-secrets-settings).

settingsRefusalsSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-07-refusals-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
