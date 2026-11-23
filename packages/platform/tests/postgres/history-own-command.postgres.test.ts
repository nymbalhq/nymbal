import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { historyOwnCommandSuite } from '../support/suites/history-own-command.js'

// A record's history names each event's own command and actor, on Postgres, on a fresh database of its own. Refuses
// to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

historyOwnCommandSuite('postgres', {
  open: async () => {
    db = await createDatabase(serverUrl, 'history_own_command')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  propertyRuns: 3,
})
