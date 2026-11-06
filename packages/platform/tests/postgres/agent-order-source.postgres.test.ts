import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { agentOrderSourceSuite } from '../support/suites/agent-order-source.js'

// AC-4 on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

agentOrderSourceSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'agent_order_source')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { runs: 8 },
)
