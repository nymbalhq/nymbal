import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { settingsRestartSuite } from '../support/suites/settings-restart.js'

// AC-3 on Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

settingsRestartSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'settings_restart')
  return { target: db.url, drop: () => db.drop() }
})
