import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { cartsCustomerIndexSuite } from '../support/suites/carts-customer-index.js'

// AC-15 on a fresh Postgres database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

cartsCustomerIndexSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'carts_customer_idx')
  return { target: db.url, drop: () => db.drop() }
})
