import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { cartAbandonmentSuite } from '../support/suites/cart-abandonment.js'

// P1-04 AC-5 to AC-9 on Postgres: the claim must hold across two pools on one database. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

cartAbandonmentSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'abandon')
  return { target: db.url, drop: () => db.drop() }
})
