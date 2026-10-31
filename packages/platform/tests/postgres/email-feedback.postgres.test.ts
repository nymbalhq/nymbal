import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { emailFeedbackSuite } from '../support/suites/email-feedback.js'

// Email bounce and complaint webhooks on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

emailFeedbackSuite('postgres', {
  open: async (opts) => {
    db = await createDatabase(serverUrl, 'feedback')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
  propertyRuns: 8,
})
