import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { inboundWebhooksStore, inboundWebhooksSuite } from '../support/suites/inbound-webhooks.js'

// Inbound webhooks on Postgres, in a fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

inboundWebhooksSuite('postgres', async () => {
  db = await createDatabase(serverUrl, 'inbound')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...inboundWebhooksStore() })
})
