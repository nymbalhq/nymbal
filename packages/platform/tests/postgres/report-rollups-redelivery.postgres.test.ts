import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { reportRollupRedeliverySuite } from '../support/suites/report-rollups-redelivery.js'

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

reportRollupRedeliverySuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'report_redelivery')
  databases.push(db)
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})

afterAll(async () => {
  for (const db of databases) await db.drop()
})
