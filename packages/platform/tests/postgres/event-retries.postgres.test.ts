import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { eventRetriesSuite } from '../support/suites/event-retries.js'

// Event delivery retries on Postgres, each kernel on a fresh database of its own. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
})

async function fresh(): Promise<string> {
  const db = await createDatabase(serverUrl, 'retries')
  databases.push(db)
  return db.url
}

eventRetriesSuite('postgres', {
  open: async ({ target, ...opts }) =>
    createKernel({ dialect: 'postgres', postgresUrl: target ?? (await fresh()), ...opts }),
  fresh,
  propertyRuns: 7,
  sequenceRuns: 2,
})
