import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { webhookRaceSuite } from '../support/suites/webhook-race.js'

// AC-12 on Postgres (required), in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

webhookRaceSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'whrace')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
