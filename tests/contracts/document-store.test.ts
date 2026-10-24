import {
  runDocumentStoreContract,
  type DocumentStoreContractOptions,
} from '@nymbalhq/contract-tests'
import { InMemoryDocumentStore } from '@nymbalhq/platform'

// runDocumentStoreContract from the published package on the in-memory store: the cases, the reference-model property
// and the health case. The store reads a test clock, so the TTL cases advance it instead of waiting. It has no
// dependency to lose, so no `unreachable`.

let now = Date.UTC(2026, 9, 20)
const opts: DocumentStoreContractOptions = {
  clock: {
    advance(ms) {
      now += ms
    },
  },
}
const make = async () => new InMemoryDocumentStore({ sweepIntervalMs: 0, now: () => now })

runDocumentStoreContract('in-memory', make, opts)
