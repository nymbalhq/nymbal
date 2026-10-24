import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { DocumentStoreAdapter } from '@nymbalhq/types'
import { CASE_MS, using, type Build } from './common.js'

// The replaceCollection cases of the document store contract: a rebuilt read model is swapped in with it, so readers
// must never see it half-built. Kills: a replace that merges (stale keys of the old set survive), one that deletes and
// writes in steps a reader can see between (a partial set), and one that empties the collection before a source that
// then throws (a failed rebuild leaves nothing).

interface Doc {
  id: string
  part: string
  v: number
}

const SLOW = 60_000
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

async function* entriesOf(docs: Doc[], pause = false): AsyncGenerator<[string, Doc]> {
  for (const doc of docs) {
    if (pause) await macrotask()
    yield [doc.id, doc]
  }
}

/** The whole collection, in key order, as `id:v` strings: what a reader saw. */
async function snapshot(store: DocumentStoreAdapter, collection: string): Promise<string[]> {
  const all = await store.query<Doc>(collection, { partitionKey: { field: 'part', value: '*' } })
  return all.items.map((d) => `${d.id}:${d.v}`)
}

const shape = (docs: Doc[]) =>
  [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((d) => `${d.id}:${d.v}`)

async function putAll(store: DocumentStoreAdapter, collection: string, docs: Doc[]) {
  for (const doc of docs) await store.put(collection, doc.id, doc)
}

const docsFrom = (keys: readonly string[], v: number): Doc[] =>
  keys.map((id) => ({ id, part: 'p', v }))

export function documentStoreReplaceCases(
  make: Build<DocumentStoreAdapter>,
  opts: { clock?: { advance(ms: number): void | Promise<void> } },
): void {
  it(
    'replaceCollection leaves exactly the new set, whatever the old and new sets: no stale key of the old set survives, and another collection is untouched (property)',
    async () => {
      await using(make, async (store) => {
        let run = 0
        await fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(fc.constantFrom(...KEYS)),
            fc.uniqueArray(fc.constantFrom(...KEYS)),
            async (oldKeys, newKeys) => {
              run += 1
              const collection = `contract-replace-${run}`
              const decoy = `contract-replace-decoy-${run}`
              await putAll(store, collection, docsFrom(oldKeys, 1))
              await putAll(store, decoy, docsFrom(oldKeys, 3))

              const next = docsFrom(newKeys, 2)
              await store.replaceCollection(collection, entriesOf(next))

              expect(await snapshot(store, collection)).toEqual(shape(next))
              for (const key of oldKeys.filter((k) => !newKeys.includes(k))) {
                expect(await store.get(collection, key), `stale key ${key}`).toBeNull()
              }
              expect(await snapshot(store, decoy)).toEqual(shape(docsFrom(oldKeys, 3)))
            },
          ),
          { numRuns: 25 },
        )
      })
    },
    SLOW,
  )

  it(
    'replaceCollection is atomic to a concurrent reader: polling while the replace runs sees only the full old set or the full new set, never a partial set',
    async () => {
      await using(make, async (store) => {
        const old = docsFrom(['a', 'b', 'c', 'd', 'e', 'f'], 1)
        const next = docsFrom(['d', 'e', 'f', 'g', 'h', 'i'], 2)
        await putAll(store, 'contract-replace-reader', old)
        const allowed = new Set([JSON.stringify(shape(old)), JSON.stringify(shape(next))])

        let done = false
        const seen: string[][] = []
        const reader = (async () => {
          while (!done) {
            seen.push(await snapshot(store, 'contract-replace-reader'))
            await macrotask()
          }
        })()
        await store
          .replaceCollection('contract-replace-reader', entriesOf(next, true))
          .finally(() => {
            done = true
          })
        await reader

        expect(seen.length, 'the reader read while the replace ran').toBeGreaterThan(0)
        for (const observed of seen) {
          expect(
            allowed.has(JSON.stringify(observed)),
            `a partial set: ${observed.join(' ')}`,
          ).toBe(true)
        }
        expect(await snapshot(store, 'contract-replace-reader')).toEqual(shape(next))
      })
    },
    CASE_MS,
  )

  it(
    'replaceCollection whose source throws part-way rejects with the source’s error and leaves the old set intact',
    async () => {
      await using(make, async (store) => {
        const old = docsFrom(['a', 'b', 'c'], 1)
        await putAll(store, 'contract-replace-failing', old)
        async function* failing(): AsyncGenerator<[string, Doc]> {
          yield ['a', { id: 'a', part: 'p', v: 2 }]
          yield ['z', { id: 'z', part: 'p', v: 2 }]
          throw new Error('contract: the source failed')
        }

        const failed = await store.replaceCollection('contract-replace-failing', failing()).then(
          () => null,
          (error: unknown) => error,
        )

        expect(String(failed)).toContain('contract: the source failed')
        expect(await snapshot(store, 'contract-replace-failing')).toEqual(shape(old))
      })
    },
    CASE_MS,
  )

  it(
    'replaceCollection with an empty source empties the collection',
    async () => {
      await using(make, async (store) => {
        await putAll(store, 'contract-replace-empty', docsFrom(['a', 'b'], 1))
        await store.replaceCollection('contract-replace-empty', entriesOf([]))
        expect(await snapshot(store, 'contract-replace-empty')).toEqual([])
        expect(await store.get('contract-replace-empty', 'a')).toBeNull()
      })
    },
    CASE_MS,
  )

  const clock = opts.clock
  if (clock !== undefined) {
    it(
      'replaceCollection writes documents without a TTL: a key whose old document had one is still there after that TTL passes',
      async () => {
        await using(make, async (store) => {
          await store.put('contract-replace-ttl', 'a', { id: 'a', part: 'p', v: 1 }, { ttl: 60 })
          await store.replaceCollection('contract-replace-ttl', entriesOf(docsFrom(['a', 'b'], 2)))
          await clock.advance(61_000)
          expect(await snapshot(store, 'contract-replace-ttl')).toEqual(['a:2', 'b:2'])
        })
      },
      CASE_MS,
    )
  }
}
