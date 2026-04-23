import { runDocumentStoreContract } from '@nymbal/contract-tests'
import { InMemoryDocumentStore } from '@nymbal/platform'

runDocumentStoreContract(() => new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
