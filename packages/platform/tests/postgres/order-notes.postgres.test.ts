import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { orderNotesMigrationSuite } from '../support/suites/order-notes-migration.js'
import { orderNotesSuite } from '../support/suites/order-notes.js'

// A shopper's checkout note and the staff notes beside it on Postgres, the property suite in a fresh database for
// this file and the migration in a fresh database of its own. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

orderNotesSuite('postgres', {
  open: async (opts) => {
    db = await createDatabase(serverUrl, 'notes')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
  propertyRuns: 6,
})

orderNotesMigrationSuite('postgres', async () => {
  const fresh = await createDatabase(serverUrl, 'staffnotes')
  return { target: fresh.url, drop: () => fresh.drop() }
})
