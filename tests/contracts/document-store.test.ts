import {
  runDocumentStoreContract,
  type DocumentStoreContractOptions,
} from '@nymbalhq/contract-tests'
import { InMemoryDocumentStore } from '@nymbalhq/platform'

// P2-02 AC-2 on the in-memory store (spec P2-02-primitives-are-protocols), and P2-13 AC-2 (spec
// P2-13-contract-tests-public): runDocumentStoreContract from the published package runs the old cases and the
// reference-model property that moved into it (decision 2), plus the health case. The store reads a test clock, so the
// TTL cases advance it instead of waiting. It has no dependency to lose, so no `unreachable`.

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
