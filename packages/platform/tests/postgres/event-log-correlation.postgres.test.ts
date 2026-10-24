import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { eventLogCorrelationSuite } from '../support/suites/event-log-correlation.js'

// AC-5 and the platform half of AC-6 on Postgres: a fresh database per case. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

eventLogCorrelationSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'p301_log')
  return { target: db.url, drop: () => db.drop() }
})
