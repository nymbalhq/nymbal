import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { sessionsMigrationSuite } from '../support/suites/sessions-migration.js'

// The session columns' migration on Postgres, a fresh database per test. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

sessionsMigrationSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'sessions_migration')
  return { target: db.url, drop: () => db.drop() }
})
