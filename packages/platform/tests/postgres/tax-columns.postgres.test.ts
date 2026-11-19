import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { taxColumnsSuite } from '../support/suites/tax-columns.js'

// AC-23 on Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

taxColumnsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'tax_columns')
  return { target: db.url, drop: () => db.drop() }
})
