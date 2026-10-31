import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { rebuildSwapSuite } from '../support/suites/rebuild-swap.js'

// On Postgres with the postgres-jsonb document store, the shared store `nymbal replay` rebuilds in place, on a fresh
// database for the file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

rebuildSwapSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'rebuild_swap')
    try {
      const kernel = await createKernel({
        dialect: 'postgres',
        postgresUrl: db.url,
        configure: (config) => ({
          ...config,
          infrastructure: {
            ...config.infrastructure,
            documentStore: { provider: 'postgres-jsonb' },
          },
        }),
      })
      return { kernel, drop: () => db.drop() }
    } catch (error) {
      await db.drop()
      throw error
    }
  },
  { runs: 5 },
)
