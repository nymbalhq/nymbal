import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsShadowedDeleteSuite } from '../support/suites/settings-shadowed-delete.js'

// On a SQLite file per test.

settingsShadowedDeleteSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-shadowed-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
