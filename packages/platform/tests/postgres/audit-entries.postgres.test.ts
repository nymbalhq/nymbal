import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { auditEntriesSuite } from '../support/suites/audit-entries.js'

// P3-04 AC-2 on Postgres (spec P3-04-audit-trail): a kernel from `src/`, served over HTTP, in a fresh database for this
// file, where a rolled-back transaction is a real one. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

auditEntriesSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'p304_entries')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { runs: 5 },
)
