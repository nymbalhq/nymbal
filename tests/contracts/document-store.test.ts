import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { InMemoryDocumentStore } from '@nymbalhq/platform'

runDocumentStoreContract(() => new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
