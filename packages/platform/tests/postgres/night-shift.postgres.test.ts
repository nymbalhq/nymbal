import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { nightShiftSuite } from '../support/suites/night-shift.js'

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

nightShiftSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'night_shift')
  databases.push(db)
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})

afterAll(async () => {
  for (const db of databases) await db.drop()
})
