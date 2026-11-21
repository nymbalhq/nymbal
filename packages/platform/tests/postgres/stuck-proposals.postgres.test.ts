import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { stuckProposalsSuite } from '../support/suites/stuck-proposals.js'

// The sweep of approved proposals on Postgres, where two sweeps hold real concurrent transactions. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

stuckProposalsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'stuck')
  return { target: db.url, drop: () => db.drop() }
})
