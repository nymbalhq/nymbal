import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { checkoutKillSuite } from '../support/suites/checkout-kill.js'

// AC-8: AC-7's child on Postgres; after the kill a fresh connection sees none of the rows. One fresh database per
// child run. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

checkoutKillSuite('AC-8', 'postgres', async () => {
  const db = await createDatabase(serverUrl, 'kill')
  return { target: db.url, drop: () => db.drop() }
})
