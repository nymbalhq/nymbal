import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { reportRollupSuite } from '../support/suites/report-rollups.js'

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

reportRollupSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'report_rollups')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  10,
)

afterAll(async () => {
  for (const db of databases) await db.drop()
})
