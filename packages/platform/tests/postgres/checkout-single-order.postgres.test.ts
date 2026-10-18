import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { singleOrderSuite } from '../support/suites/single-order.js'

// P1-12 AC-3 on Postgres, where the lock-then-insert race is real, in a fresh database for this file. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

singleOrderSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'single_order')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
