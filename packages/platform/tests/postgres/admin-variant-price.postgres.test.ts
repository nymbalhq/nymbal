import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { adminVariantPriceSuite } from '../support/suites/admin-variant-price.js'

// The admin's variant price edit on Postgres, on a fresh database. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
})

adminVariantPriceSuite('postgres', {
  open: async () => {
    const db = await createDatabase(serverUrl, 'variant_price')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  propertyRuns: 4,
})
