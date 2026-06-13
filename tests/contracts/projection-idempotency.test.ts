import { runProjectionContract } from '@nymbal/contract-tests'
import { InMemoryDocumentStore, createProcessedEventRepository, withIdempotency, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })

runProjectionContract({
  build: async () => {
    const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const repo = createProcessedEventRepository(documentStore)
    let count = 0
    const wrapped = withIdempotency(
      'test-projection',
      async (_event) => { count++ },
      { repo, logger },
    )
    return {
      handle: async (event) => { await wrapped(event) },
      applicationCount: async () => count,
    }
  },
})
