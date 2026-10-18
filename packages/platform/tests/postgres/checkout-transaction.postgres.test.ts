import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { checkoutTransactionSuite } from '../support/suites/checkout-transaction.js'

// P1-02 AC-6, AC-10 and AC-11 (the index) on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

checkoutTransactionSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'checkout')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { thousandPendingOrders: false },
)
