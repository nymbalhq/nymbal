import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { underpaymentSuite } from '../support/suites/underpayment.js'

// P1-05 AC-3 on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

underpaymentSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'underpay')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { serviceRuns: 5, httpRuns: 2 },
)
