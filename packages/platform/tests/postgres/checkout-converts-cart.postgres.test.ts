import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { checkoutConvertsCartSuite } from '../support/suites/checkout-converts-cart.js'

// P1-04 AC-4 and AC-4b on Postgres, one fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

checkoutConvertsCartSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'convert')
  return { target: db.url, drop: () => db.drop() }
})
