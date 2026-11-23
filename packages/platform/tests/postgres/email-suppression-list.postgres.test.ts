import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { emailSuppressionListSuite } from '../support/suites/email-suppression-list.js'

// The suppression list on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

emailSuppressionListSuite('postgres', {
  open: async () => {
    db = await createDatabase(serverUrl, 'suppressions')
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
      { postgresUrl: db.url },
    )
    await runMigrations(store, { migrationsRoot: MIGRATIONS })
    return store
  },
  propertyRuns: 15,
})
