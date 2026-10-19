import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { outboxSuite } from '../support/suites/outbox.js'

// P1-03 AC-4 and AC-5 on Postgres with the default pool, in a fresh database for this file: here a row whose seq was
// allocated before, but committed after, a delivered row is the one a cursor-based relay would skip. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

outboxSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'outbox')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { propertyRuns: 10 },
)
