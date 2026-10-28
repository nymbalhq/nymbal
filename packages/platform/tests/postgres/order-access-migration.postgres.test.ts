import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { keylessOrdersSuite } from '../support/suites/order-access-migration.js'

// AC-3 on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

keylessOrdersSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'order_access_migration')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
