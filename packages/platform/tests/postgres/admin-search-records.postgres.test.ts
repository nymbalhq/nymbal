import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { adminSearchRecordsSuite } from '../support/suites/admin-search-records.js'

// The admin global search over orders and customers on Postgres, on a fresh database of its own. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

adminSearchRecordsSuite('postgres', {
  open: async () => {
    db = await createDatabase(serverUrl, 'admin_search_records')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
})
