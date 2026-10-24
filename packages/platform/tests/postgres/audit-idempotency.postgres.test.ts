import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { idempotencySuite } from '../support/suites/audit-idempotency.js'

// AC-1 on Postgres: a kernel from `src/`, served over HTTP, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL. The concurrent runs reach the partial unique index on `applied` rows from several pooled
// connections at once.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

idempotencySuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'p304_idem')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { runs: 10 },
)
