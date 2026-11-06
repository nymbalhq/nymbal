import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { sseTicketSuite } from '../support/suites/sse-ticket.js'

// On Postgres with the postgres-jsonb document store, the store several instances share, on a fresh database for the
// file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

sseTicketSuite('postgres, postgres-jsonb', async (configure) => {
  const db = await createDatabase(serverUrl, 'sse_ticket')
  try {
    const kernel = await createKernel({
      dialect: 'postgres',
      postgresUrl: db.url,
      configure: (config) => {
        const own = configure(config)
        return {
          ...own,
          infrastructure: { ...own.infrastructure, documentStore: { provider: 'postgres-jsonb' } },
        }
      },
    })
    // The suite stops the served kernel (which closes it) before it drops the database.
    return { kernel, drop: () => db.drop() }
  } catch (error) {
    await db.drop()
    throw error
  }
})
