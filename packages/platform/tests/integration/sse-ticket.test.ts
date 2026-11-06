import type { DocumentStoreAdapter } from '@nymbalhq/types'
import { createKernel } from '../support/kernel.js'
import { sseTicketSuite } from '../support/suites/sse-ticket.js'

// On SQLite with the in-memory document store, each of whose reads and writes waits one turn of the event loop first,
// as a shared store's round trip does: the in-memory store answers at once, so without the wait no second open could
// run between one open's read and its write. The Postgres run, on postgres-jsonb, is in integration-postgres
// (packages/platform/tests/postgres/sse-ticket.postgres.test.ts).

function withRoundTrips(store: DocumentStoreAdapter): void {
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
  const get = store.get.bind(store)
  const put = store.put.bind(store)
  store.get = async (...args) => {
    await turn()
    return get(...args)
  }
  store.put = async (...args) => {
    await turn()
    return put(...args)
  }
}

sseTicketSuite('sqlite, in-memory with round trips', async (configure) => {
  const kernel = await createKernel({ dialect: 'sqlite', configure })
  withRoundTrips(kernel.documentStore)
  return { kernel, drop: async () => {} }
})
