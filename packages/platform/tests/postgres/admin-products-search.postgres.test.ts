import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { adminProductsSearchSuite } from '../support/suites/admin-products-search.js'

// The admin products search on Postgres, on a fresh database of its own. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

adminProductsSearchSuite('postgres', {
  open: async () => {
    db = await createDatabase(serverUrl, 'products_search')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  propertyRuns: 4,
})
