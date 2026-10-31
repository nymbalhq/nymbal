import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { orderSequenceSuite } from '../support/suites/order-sequence.js'

// Order numbers on Postgres, each store a kernel on a fresh database dropped when the kernel closes. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

orderSequenceSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'order_sequence')
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
