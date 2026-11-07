import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { orderListFilterSuite } from '../support/suites/order-list-filter.js'

// The admin order list's filters and count on Postgres, each describe on a fresh database dropped when its kernel
// closes. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

orderListFilterSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'order_list_filter')
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
