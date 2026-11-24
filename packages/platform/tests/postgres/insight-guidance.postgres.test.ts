import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { insightGuidanceSuite } from '../support/suites/insight-guidance.js'

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

insightGuidanceSuite('postgres', async (opts) => {
  const db = await createDatabase(serverUrl, 'insight_guidance')
  databases.push(db)
  return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
})

afterAll(async () => {
  for (const db of databases) await db.drop()
})
