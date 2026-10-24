import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { inventoryConcurrencySuite } from '../support/suites/inventory-concurrency.js'

// AC-3, AC-13 and AC-16 on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

inventoryConcurrencySuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'inventory')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { propertyRuns: 10 },
)
