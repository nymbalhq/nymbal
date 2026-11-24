import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { oldPlatformSignInSuite } from '../support/suites/old-platform-sign-in.js'

// First sign-ins through the old platform racing each other on Postgres, on a fresh database. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
}, 60_000)

oldPlatformSignInSuite('postgres', {
  open: async (opts) => {
    const db = await createDatabase(serverUrl, 'old_platform_sign_in')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
})
