import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutConvertsCartSuite } from '../support/suites/checkout-converts-cart.js'

// AC-4 and AC-4b on a SQLite file: a SIGKILL after the finalize commit leaves a confirmed order next to an empty cart,
// and an expired cart does not stop finalize.

checkoutConvertsCartSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cart-convert-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
