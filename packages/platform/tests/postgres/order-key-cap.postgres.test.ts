import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { orderKeyCapSuite } from '../support/suites/order-key-cap.js'

// AC-5 on Postgres, where the mint's transaction is real, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

orderKeyCapSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'order_key_cap')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
