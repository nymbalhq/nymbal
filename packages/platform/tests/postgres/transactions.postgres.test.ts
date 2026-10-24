import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { transactionsSuite } from '../support/suites/transactions.js'

// AC-5 and AC-9 on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

transactionsSuite('AC-5', 'postgres', async () => {
  db = await createDatabase(serverUrl, 'tx')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
