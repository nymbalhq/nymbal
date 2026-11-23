import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionsSuite } from '../support/suites/sessions.js'

// Signed-in devices on SQLite, on a real file a second store can open beside the first.

sessionsSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-'))
    return {
      target: join(dir, 'store.sqlite'),
      drop: async () => {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { propertyRuns: 30 },
)
