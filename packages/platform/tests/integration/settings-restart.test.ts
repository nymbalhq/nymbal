import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsRestartSuite } from '../support/suites/settings-restart.js'

// AC-3 on a SQLite file per test.

settingsRestartSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-restart-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
