import { runSearchContract } from '@nymbal/contract-tests'
import { createNativeSearchAdapter, InMemoryDocumentStore, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runSearchContract(() => createNativeSearchAdapter({
  documentStore: new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
  logger,
}))
