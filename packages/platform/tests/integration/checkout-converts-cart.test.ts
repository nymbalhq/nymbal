import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutConvertsCartSuite } from '../support/suites/checkout-converts-cart.js'

// P1-04 AC-4 and AC-4b on a SQLite file: a SIGKILL after the finalize commit leaves a confirmed order next to an
// empty cart, and an expired cart does not stop finalize.

checkoutConvertsCartSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-04-convert-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
