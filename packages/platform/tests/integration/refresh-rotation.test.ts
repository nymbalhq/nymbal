import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshRotationSuite } from '../support/suites/refresh-rotation.js'

// Refresh rotation on SQLite, on a real file a second store can open beside the first.

refreshRotationSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-rotation-'))
    return {
      target: join(dir, 'store.sqlite'),
      drop: async () => {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { propertyRuns: 30 },
)
