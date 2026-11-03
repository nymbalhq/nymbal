import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { reviewsOnceSuite } from '../support/suites/reviews-once.js'

// AC-6 on Postgres (READ COMMITTED: two submissions both find no review unless the pair is locked), in a fresh
// database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

reviewsOnceSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'reviews_once')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { propertyRuns: 20 },
)
