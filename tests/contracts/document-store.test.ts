import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { InMemoryDocumentStore } from '@nymbalhq/platform'
import {
  documentStoreAcceptance,
  type DocumentStoreAcceptanceOptions,
} from './suites/document-store'

// P2-02 AC-2 on the in-memory store (spec P2-02-primitives-are-protocols): the extended runDocumentStoreContract and
// the reference-model property (./suites/document-store.ts, which absorbed P1-11's runOrderingContract, decision 3).
// The store reads a test clock, so the TTL cases advance it instead of waiting.

let now = Date.UTC(2026, 9, 20)
const opts: DocumentStoreAcceptanceOptions = {
  clock: {
    advance(ms) {
      now += ms
    },
  },
}
const make = async () => new InMemoryDocumentStore({ sweepIntervalMs: 0, now: () => now })

runDocumentStoreContract('in-memory', make, opts)
documentStoreAcceptance('in-memory', make, opts)
