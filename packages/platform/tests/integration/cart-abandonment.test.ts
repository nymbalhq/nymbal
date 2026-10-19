import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cartAbandonmentSuite } from '../support/suites/cart-abandonment.js'

// P1-04 AC-5 to AC-9 on a SQLite file: one notice per inactivity period across restarts and replicas, no batch cap,
// sliding expiry.

cartAbandonmentSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-04-abandon-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
