import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { customerStatsSuite } from '../support/suites/customer-stats.js'

// A customer page's stats on Postgres, on a fresh database dropped when the kernel closes. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

customerStatsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'customer_stats')
  const k = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
  return {
    ...k,
    async close() {
      try {
        await k.close()
      } finally {
        await db.drop()
      }
    },
  }
})
