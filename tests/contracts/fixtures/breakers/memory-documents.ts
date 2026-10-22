import { InMemoryDocumentStore } from '@nymbalhq/platform'
import type { DocumentStoreContractOptions } from '@nymbalhq/contract-tests'
import type { DocumentStoreAdapter, PutOptions, QueryParams } from '@nymbalhq/types'

// The in-memory document store for the replaceCollection breakers (P3-02 AC-1, spec P3-02-replay-engine decision 2):
// the real store as the control, and the same store with replaceCollection swapped for a defective one. Each defect
// gets the end state right on a good source where it can, so the suite's case about that defect is what fails:
//   not-atomic:      reads the source in full, then deletes the old keys and puts the new ones a macrotask apart, so a
//                    reader between them sees part of the old set or part of the new;
//   merges:          puts the new entries over the old set and deletes nothing, so stale keys survive;
//   failure-empties: deletes the old set before it reads the source, so a source that throws leaves it empty.
// The defective stores track their own keys (the adapter has no way to list them) through put, batchPut and delete.

export type ReplaceFlaw = 'not-atomic' | 'merges' | 'failure-empties'

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Fresh stores on one test clock, and the suite options that advance it. */
export function documentsOnClock(): {
  make(flaw?: ReplaceFlaw): Promise<DocumentStoreAdapter>
  options: DocumentStoreContractOptions
} {
  let now = Date.UTC(2026, 9, 21)
  return {
    async make(flaw) {
      const inner = new InMemoryDocumentStore({ sweepIntervalMs: 0, now: () => now })
      return flaw === undefined ? inner : flawed(inner, flaw)
    },
    options: {
      clock: {
        advance(ms) {
          now += ms
        },
      },
    },
  }
}

function flawed(inner: InMemoryDocumentStore, flaw: ReplaceFlaw): DocumentStoreAdapter {
  const keys = new Map<string, Set<string>>()
  const keysOf = (collection: string): Set<string> => {
    let set = keys.get(collection)
    if (set === undefined) keys.set(collection, (set = new Set()))
    return set
  }
  const put = async (collection: string, key: string, doc: unknown, options?: PutOptions) => {
    await inner.put(collection, key, doc, options)
    keysOf(collection).add(key)
  }
  const remove = async (collection: string, key: string) => {
    await inner.delete(collection, key)
    keysOf(collection).delete(key)
  }
  const drain = async (entries: AsyncIterable<[string, unknown]>) => {
    const all: Array<[string, unknown]> = []
    for await (const entry of entries) all.push(entry)
    return all
  }

  const store = {
    capabilities: () => inner.capabilities(),
    healthCheck: () => inner.healthCheck(),
    get: <T>(collection: string, key: string) => inner.get<T>(collection, key),
    put,
    delete: remove,
    query: <T>(collection: string, params: QueryParams) => inner.query<T>(collection, params),
    batchGet: <T>(collection: string, list: string[]) => inner.batchGet<T>(collection, list),
    async batchPut<T>(collection: string, items: Map<string, T>) {
      for (const [key, doc] of items) await put(collection, key, doc)
    },
    close: () => inner.close(),
    async replaceCollection(collection: string, entries: AsyncIterable<[string, unknown]>) {
      if (flaw === 'failure-empties') {
        for (const key of [...keysOf(collection)]) await remove(collection, key)
        for (const [key, doc] of await drain(entries)) await put(collection, key, doc)
        return
      }
      const next = await drain(entries)
      if (flaw === 'merges') {
        for (const [key, doc] of next) await put(collection, key, doc)
        return
      }
      for (const key of [...keysOf(collection)]) {
        await remove(collection, key)
        await macrotask()
      }
      for (const [key, doc] of next) {
        await put(collection, key, doc)
        await macrotask()
      }
    },
  }
  return store as unknown as DocumentStoreAdapter
}
