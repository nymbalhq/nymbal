import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { cancelConfirmRaceSuite } from '../support/suites/cancel-confirm-race.js'

// P1-13 diff review B2 on Postgres (the cancel's guard needs SELECT … FOR UPDATE), in a fresh database for this file.
// Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

cancelConfirmRaceSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'cancel_confirm')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
