import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { refreshRotationSuite } from '../support/suites/refresh-rotation.js'

// Refresh rotation on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

refreshRotationSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'refresh_rotation')
    return { target: db.url, drop: () => db.drop() }
  },
  { propertyRuns: 8 },
)
