import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { orderAccessSuite } from '../support/suites/order-access.js'

// AC-6 on Postgres, where the placement transaction is real, in a fresh database for this file. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

orderAccessSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'order_access')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
