import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { partialRefundFulfilmentSuite } from '../support/suites/partial-refund-fulfilment.js'

// A partially refunded order moved on through the admin's routes, on Postgres, in a fresh database for the file.
// Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

partialRefundFulfilmentSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'partial_refund_fulfil')
    return { target: db.url, drop: () => db.drop() }
  },
  { runs: 4 },
)
