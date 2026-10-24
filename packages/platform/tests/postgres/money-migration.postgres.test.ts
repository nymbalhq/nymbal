import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { moneyMigrationSuite } from '../support/suites/money-migration.js'

// AC-8 on Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

moneyMigrationSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'money')
  return { target: db.url, drop: () => db.drop() }
})
