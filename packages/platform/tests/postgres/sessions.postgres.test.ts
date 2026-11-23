import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { sessionsSuite } from '../support/suites/sessions.js'

// Signed-in devices on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

sessionsSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'sessions')
    return { target: db.url, drop: () => db.drop() }
  },
  { propertyRuns: 8 },
)
