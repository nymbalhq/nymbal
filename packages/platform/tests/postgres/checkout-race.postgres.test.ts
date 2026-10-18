import { startTestStore } from '../support/proof-kit.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { openRaw } from '../support/raw.js'
import { checkoutRaceSuite } from '../support/suites/checkout-race.js'

// P1-02 AC-2: the checkout race on Postgres with the pool at its default size, over HTTP on startTestStore, in a
// fresh database for this file. The file refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

checkoutRaceSuite('AC-2', async () => {
  const db = await createDatabase(serverUrl, 'race')
  const store = await startTestStore({ commandStore: 'postgres', postgresUrl: db.url })
  const raw = openRaw('postgres', db.url)
  return {
    store,
    raw,
    async stop() {
      await raw.close()
      await store.stop()
      await db.drop()
    },
  }
})
