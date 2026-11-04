import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { dashboardAgentsSuite } from '../support/suites/dashboard-agents.js'

// AC-6 on Postgres, each kernel in a fresh database of its own. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const dbs: TestDatabase[] = []

afterAll(async () => {
  for (const db of dbs) await db.drop()
})

dashboardAgentsSuite(
  'postgres',
  async (configure) => {
    const db = await createDatabase(serverUrl, 'dashboard_agents')
    dbs.push(db)
    return createKernel({
      dialect: 'postgres',
      postgresUrl: db.url,
      ...(configure !== undefined && { configure }),
    })
  },
  { runs: 8 },
)
