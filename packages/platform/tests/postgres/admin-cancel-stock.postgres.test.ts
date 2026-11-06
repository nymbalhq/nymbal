import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { adminCancelStockSuite } from '../support/suites/admin-cancel-stock.js'

// AC-1 and AC-3 on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

adminCancelStockSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'admin_cancel_stock')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { runs: 8 },
)
