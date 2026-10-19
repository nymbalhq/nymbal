import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { refundRaceSuite } from '../support/suites/refund-race.js'

// P1-13 AC-5 on Postgres (the lock is SELECT … FOR UPDATE), a fresh database for the file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

refundRaceSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'refund_race')
  return { target: db.url, drop: () => db.drop() }
})
