import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { settingsShadowedDeleteSuite } from '../support/suites/settings-shadowed-delete.js'

// On Postgres, a fresh database per test. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

settingsShadowedDeleteSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'settings_shadowed')
  return { target: db.url, drop: () => db.drop() }
})
