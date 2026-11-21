import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { mailAfterAnswerSuite } from '../support/suites/mail-after-answer.js'

// Forgot, resend and register answering before their mail, and a crash between the answer and the mail, on Postgres,
// each store on a fresh database of its own. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
const databases: TestDatabase[] = []

afterAll(async () => {
  for (const db of databases.splice(0)) await db.drop()
}, 60_000)

mailAfterAnswerSuite('postgres', {
  open: async (opts) => {
    const db = await createDatabase(serverUrl, 'mail_after_answer')
    databases.push(db)
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
  database: async () => {
    const db = await createDatabase(serverUrl, 'mail_after_crash')
    return {
      open: (opts) => createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts }),
      drop: () => db.drop(),
    }
  },
})
