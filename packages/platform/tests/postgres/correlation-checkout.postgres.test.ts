import { startTestStore } from '../support/proof-kit.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { openRaw } from '../support/raw.js'
import { checkoutCorrelationSuite } from '../support/suites/correlation-checkout.js'

// P3-01 AC-1 and AC-1b on Postgres (spec P3-01-event-log-surface), over HTTP on startTestStore, in a fresh database for
// this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL. The kit runs the built kernel: `pnpm build` first.

const serverUrl = postgresServerUrl()

checkoutCorrelationSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'p301_checkout')
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
  },
  { runs: 6 },
)
