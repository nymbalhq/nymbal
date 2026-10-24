import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { idempotencyRestartSuite } from '../support/suites/idempotency-restart.js'

// AC-7 on Postgres: two kernels, one after the other, on one fresh database. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

idempotencyRestartSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'idem')
  return {
    open: () => createKernel({ dialect: 'postgres', postgresUrl: db.url }),
    drop: () => db.drop(),
  }
})
