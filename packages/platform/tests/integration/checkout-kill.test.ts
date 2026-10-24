import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutKillSuite } from '../support/suites/checkout-kill.js'

// AC-7: a SIGKILL inside beginCheckout on a SQLite file leaves no partial order.

checkoutKillSuite('AC-7', 'sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'txn-kill-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
