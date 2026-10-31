import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { shippingTrackingSuite } from '../support/suites/shipping-tracking.js'

// Shipping tracking webhooks on Postgres, in a fresh database for this file. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

shippingTrackingSuite('postgres', {
  open: async (opts) => {
    db = await createDatabase(serverUrl, 'tracking')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts })
  },
  propertyRuns: 5,
})
