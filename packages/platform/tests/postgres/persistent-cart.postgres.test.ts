import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { persistentCartSuite } from '../support/suites/persistent-cart.js'

// AC-1, AC-2 and AC-3 on Postgres (READ COMMITTED: the no-lost-update property needs a row lock or a conditional
// write), in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

persistentCartSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'cart')
    return { target: db.url, drop: () => db.drop() }
  },
  { propertyRuns: 6 },
)
