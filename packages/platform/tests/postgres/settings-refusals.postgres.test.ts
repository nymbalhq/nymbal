import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { settingsRefusalsSuite } from '../support/suites/settings-refusals.js'

// AC-6 on Postgres, a fresh database per test; the "no relation" case is a database migrated only to 0007. Refuses
// to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

settingsRefusalsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'settings_refusals')
  return { target: db.url, drop: () => db.drop() }
})
