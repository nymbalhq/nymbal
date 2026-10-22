import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { idempotencySuite } from '../support/suites/audit-idempotency.js'

// P3-04 AC-1 on Postgres (spec P3-04-audit-trail): a kernel from `src/`, served over HTTP, in a fresh database for this
// file. Refuses to load without NYMBAL_TEST_POSTGRES_URL. The concurrent runs reach the partial unique index on
// `applied` rows (decision 5's race) from several pooled connections at once.

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
