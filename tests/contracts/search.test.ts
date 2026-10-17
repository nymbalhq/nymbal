import { runSearchContract } from '@nymbalhq/contract-tests'
import { createNativeSearchAdapter, InMemoryDocumentStore, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runSearchContract(() => createNativeSearchAdapter({
  documentStore: new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
  logger,
}))
