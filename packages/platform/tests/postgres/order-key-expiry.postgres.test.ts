import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { orderKeyExpirySuite } from '../support/suites/order-key-expiry.js'

// AC-1 on Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

orderKeyExpirySuite('postgres', async (tag) => {
  const db = await createDatabase(serverUrl, tag)
  return { target: db.url, drop: () => db.drop() }
})
