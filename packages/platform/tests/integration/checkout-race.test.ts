import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestStore } from '../support/proof-kit.js'
import { openRaw } from '../support/raw.js'
import { checkoutRaceSuite } from '../support/suites/checkout-race.js'

// AC-1: the checkout race on SQLite, over HTTP on startTestStore.

checkoutRaceSuite('AC-1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'txn-race-'))
  const sqlitePath = join(dir, 'store.sqlite')
  const store = await startTestStore({ sqlitePath })
  const raw = openRaw('sqlite', sqlitePath)
  return {
    store,
    raw,
    async stop() {
      await raw.close()
      await store.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
