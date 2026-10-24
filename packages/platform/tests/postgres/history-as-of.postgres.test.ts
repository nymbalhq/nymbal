import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { historyAsOfSuite } from '../support/suites/history-as-of.js'

// AC-1 on Postgres: a kernel from `src/`, served over HTTP, in a fresh database
// for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

historyAsOfSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'p303_as_of')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { runs: 3, maxSteps: 12 },
)
