import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { historyBoundsSuite } from '../support/suites/history-bounds.js'

// AC-2 on Postgres: kernels from `src/`, served over HTTP, each in a fresh
// database. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const dbs: TestDatabase[] = []

afterAll(async () => {
  for (const db of dbs) await db.drop()
})

historyBoundsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'p303_bounds')
  dbs.push(db)
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})
