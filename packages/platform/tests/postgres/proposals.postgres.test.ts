import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { proposalRacesSuite, type FreshDatabase } from '../support/suites/proposals.js'

// The races for one proposal row and one decision on Postgres (the unique index and the conditional update under
// real concurrency), a fresh database per store. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

const fresh: FreshDatabase = async (label) => {
  const db = await createDatabase(serverUrl, `proposals_${label.replace(/[^a-z0-9]/gi, '_')}`)
  return { target: db.url, drop: () => db.drop() }
}

proposalRacesSuite('postgres', fresh)
