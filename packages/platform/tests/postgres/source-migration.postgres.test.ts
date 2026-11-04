import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { sourceMigrationSuite } from '../support/suites/source-migration.js'

// AC-5 on Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

sourceMigrationSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'source')
  return { target: db.url, drop: () => db.drop() }
})
