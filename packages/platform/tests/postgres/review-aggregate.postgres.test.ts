import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { reviewAggregateSuite } from '../support/suites/review-aggregate.js'

// The aggregate rating on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

reviewAggregateSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'review_aggregate')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { propertyRuns: 20 },
)
