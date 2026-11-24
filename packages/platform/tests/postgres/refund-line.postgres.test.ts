import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { refundLineSuite } from '../support/suites/refund-line.js'

// A refund names its order line on Postgres, where the line columns are their own migration. A fresh database for the
// file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

refundLineSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'refund_line')
  return { target: db.url, drop: () => db.drop() }
})
