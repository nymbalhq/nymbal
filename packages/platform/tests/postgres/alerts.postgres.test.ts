import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { alertsSuite } from '../support/suites/alerts.js'

// Back-in-stock alerts on Postgres, each kernel and the migration on a fresh database of its own. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
})

async function database(): Promise<string> {
  const db = await createDatabase(serverUrl, 'alerts')
  databases.push(db)
  return db.url
}

alertsSuite('postgres', {
  open: async (opts) =>
    createKernel({ dialect: 'postgres', postgresUrl: await database(), ...opts }),
  fresh: database,
  propertyRuns: 5,
})
