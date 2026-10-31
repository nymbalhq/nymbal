import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderKeyExpirySuite } from '../support/suites/order-key-expiry.js'

// AC-1 on a SQLite file per test.

orderKeyExpirySuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-expiry-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
