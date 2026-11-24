import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { QUIET_RELAY } from '../support/report-rebuild.js'
import { reportRebuildSuite } from '../support/suites/report-rebuild.js'

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

reportRebuildSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'report_rebuild')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, appOptions: QUIET_RELAY })
  },
  8,
)

afterAll(async () => {
  for (const db of databases) await db.drop()
})
