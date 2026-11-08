import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { reviewVerifiedMoneySuite } from '../support/suites/review-verified-money.js'

// A verified review and the order's money, on Postgres, in a database of the file's own. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

reviewVerifiedMoneySuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'review_verified_money')
    const kernel = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
    const close = kernel.close.bind(kernel)
    return {
      ...kernel,
      async close() {
        await close()
        await db.drop()
      },
    }
  },
  { runs: 8 },
)
