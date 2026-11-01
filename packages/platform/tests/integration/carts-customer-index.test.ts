import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cartsCustomerIndexSuite } from '../support/suites/carts-customer-index.js'

// AC-15 on a fresh SQLite file.

cartsCustomerIndexSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'carts-idx-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
