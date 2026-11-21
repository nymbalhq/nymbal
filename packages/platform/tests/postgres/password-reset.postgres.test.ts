import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { passwordResetSuite } from '../support/suites/password-reset.js'

// "Forgot password?" on Postgres, each kernel on a fresh database of its own. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
}, 60_000)

passwordResetSuite('postgres', {
  open: async (opts) => {
    const db = await createDatabase(serverUrl, 'password_reset')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
  propertyRuns: 4,
})
