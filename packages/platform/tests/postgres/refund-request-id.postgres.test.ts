import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { refundRequestIdSuite } from '../support/suites/refund-request-id.js'

// P1-13 store walk (`standing.submit-once-admin`) on Postgres, where two repeats of one requestId truly run at once and
// only the unique index on (order_id, request_id) or the row lock keeps them to one refund. A fresh database for the
// file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

refundRequestIdSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'refund_request_id')
  return { target: db.url, drop: () => db.drop() }
})
