import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { eventSubjectSuite } from '../support/suites/event-subject.js'

// AC-4 on Postgres: a fresh database per case. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

eventSubjectSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'p303_subject')
  return { target: db.url, drop: () => db.drop() }
})
