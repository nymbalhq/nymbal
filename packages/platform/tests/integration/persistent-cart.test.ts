import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistentCartSuite } from '../support/suites/persistent-cart.js'

// P1-04 AC-1, AC-2 and AC-3 on a SQLite file: restarts and two replicas (two command stores) over one file.

persistentCartSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-04-cart-'))
    return {
      target: join(dir, 'store.sqlite'),
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { propertyRuns: 10 },
)
