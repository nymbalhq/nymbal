import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { rolesColumnSuite } from '../support/suites/roles-column.js'

// AC-11 (migration 0004's jsonb backfill) and AC-12 on Postgres, a fresh database per test. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

rolesColumnSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'roles')
  return { target: db.url, drop: () => db.drop() }
})
