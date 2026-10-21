import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { searchBackfillSuite } from '../support/suites/search-backfill.js'

// P2-07 AC-6 on Postgres: two kernels, one after the other, on one fresh database. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

searchBackfillSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'search_backfill')
  return {
    open: () => createKernel({ dialect: 'postgres', postgresUrl: db.url }),
    drop: () => db.drop(),
  }
})
