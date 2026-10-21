import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  compareDocumentValues,
  matchesSortKey,
  type DocumentStoreAdapter,
  type QueryParams,
} from '@nymbalhq/types'

// P2-02 AC-2 (spec P2-02-primitives-are-protocols), the document store contract as a property against the reference
// model of decision 3. Every implementation's test file runs it beside `runDocumentStoreContract` from
// @nymbalhq/contract-tests, with the same `make` and options: in-memory in tests/contracts, Redis and Postgres JSONB
// in their own packages. It absorbs P1-11's ordering cases (tests/contracts/document-store.test.ts): each store's page
// sequence, over decision 3's generator domain, equals the reference (filter with matchesSortKey, order with
// compareDocumentValues, nulls last, ties by key, slice by `limit`).
// Kills: a store that filters `eq` as text (1 against '1'), orders strings by bytes instead of the collator, places
// nulls or missing fields first, ignores a dotted path, restarts or repeats a cursor walk (also across a delete),
// accepts a cursor under another order, ignores or misreads a TTL, skips a put condition, or leaks across a
// collection or a prefix.

export interface DocumentStoreAcceptanceOptions {
  /** A test clock the store reads: TTL cases advance it instead of waiting. Without it they wait a 1 s TTL out. */
  clock?: { advance(ms: number): void | Promise<void> }
  /** Two stores on one backend with different prefixes. Redis and Postgres JSONB pass it; in-memory has no prefix. */
  isolation?: () => Promise<[DocumentStoreAdapter, DocumentStoreAdapter]>
}

const COLLECTION = 'p2-02-docs'
const DECOY = 'p2-02-decoy'
const SLOW = 60_000

type Value = string | number | null

/** A stored document. `v` and `nested.v` are absent when the generator chose "missing". */
interface Doc {
  id: string
  part: string
  v?: Value
  nested: { v?: Value }
  label: string
}

interface Generated {
  key: string
  part: 'p' | 'q'
  v: Value | undefined
  n: Value | undefined
}

/** Decision 3's domain: case, accent and equal-base strings, ints next to numeric strings, and null. */
const valueArb: fc.Arbitrary<Value> = fc.oneof(
  fc.constantFrom('a', 'A', 'á', 'b', 'B', 'é', 'e', 'ab', 'Ab', '1', '10', '2'),
  fc.integer({ min: -2, max: 10 }),
  fc.constant(null),
)
/** A field holding a domain value, or missing (undefined). */
const fieldArb = fc.option(valueArb, { nil: undefined, freq: 4 })

const docsArb = (minLength: number) =>
  fc.uniqueArray(
    fc.record({
      // Random keys, so key order is unrelated to value order.
      key: fc.stringMatching(/^[a-z0-9]{1,6}$/),
      part: fc.constantFrom<'p' | 'q'>('p', 'q'),
      v: fieldArb,
      n: fieldArb,
    }),
    { minLength, maxLength: 14, selector: (d) => d.key },
  )

type SortKey = NonNullable<QueryParams['sortKey']>
type Direction = 'asc' | 'desc'

const sortKeyArb: fc.Arbitrary<SortKey | undefined> = fc.option(
  fc.oneof(
    fc.record({
      field: fc.constant('v'),
      operator: fc.constantFrom<'eq' | 'gt' | 'lt'>('eq', 'gt', 'lt'),
      value: valueArb as fc.Arbitrary<unknown>,
    }),
    fc.record({
      field: fc.constant('v'),
      operator: fc.constant<'between'>('between'),
      value: fc.tuple(valueArb, valueArb) as fc.Arbitrary<unknown>,
    }),
  ),
  { nil: undefined },
)
const orderByArb = fc.record({
  field: fc.constantFrom('v', 'nested.v'),
  direction: fc.constantFrom<Direction>('asc', 'desc'),
})

function stored(g: Generated): Doc {
  return {
    id: g.key,
    part: g.part,
    ...(g.v !== undefined && { v: g.v }),
    nested: g.n !== undefined ? { v: g.n } : {},
    label: 'Ünïcödé ✓',
  }
}

function valueAt(doc: Doc, path: string): unknown {
  let value: unknown = doc
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

const nullish = (v: unknown): boolean => v === null || v === undefined

interface Query {
  partition: 'p' | '*'
  sortKey: SortKey | undefined
  orderBy: { field: string; direction: Direction } | undefined
}

/** Decision 3's reference: filter by partition and matchesSortKey, then order (when asked) by compareDocumentValues. */
function reference(docs: Doc[], q: Query): string[] {
  const hits = docs.filter(
    (d) =>
      (q.partition === '*' || d.part === q.partition) &&
      (q.sortKey === undefined || matchesSortKey(d.v, q.sortKey)),
  )
  const { orderBy } = q
  if (orderBy === undefined) return hits.map((d) => d.id).sort()
  return hits
    .sort((a, b) => {
      const x = valueAt(a, orderBy.field)
      const y = valueAt(b, orderBy.field)
      // nulls: 'last' in both directions; a missing field is a null.
      if (nullish(x) !== nullish(y)) return nullish(x) ? 1 : -1
      let c = nullish(x) ? 0 : compareDocumentValues(x, y)
      if (orderBy.direction === 'desc') c = -c
      if (c !== 0) return c
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((d) => d.id)
}

function params(q: Query, limit: number, cursor?: string): QueryParams {
  return {
    partitionKey: { field: 'part', value: q.partition },
    ...(q.sortKey !== undefined && { sortKey: q.sortKey }),
    ...(q.orderBy !== undefined && { orderBy: { ...q.orderBy, nulls: 'last' as const } }),
    limit,
    ...(cursor !== undefined && { cursor }),
  }
}

/** Every page of a cursor walk. `between` runs after each page; the walk stops after `docs + 2` pages. */
async function walk(
  store: DocumentStoreAdapter,
  q: Query,
  limit: number,
  maxPages: number,
  between?: (page: number) => Promise<void>,
): Promise<{ pages: Doc[][]; ended: boolean }> {
  const pages: Doc[][] = []
  let cursor: string | undefined
  do {
    const page = await store.query<Doc>(COLLECTION, params(q, limit, cursor))
    pages.push(page.items)
    cursor = page.nextCursor ?? undefined
    if (between !== undefined) await between(pages.length)
  } while (cursor !== undefined && pages.length <= maxPages)
  return { pages, ended: cursor === undefined }
}

const idsOf = (docs: Doc[]): string[] => docs.map((d) => d.id)

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** A final empty page (a cursor issued on an exact multiple of `limit`) adds nothing to the sequence. */
function withoutTrailingEmpty<T>(pages: T[][]): T[][] {
  return pages.length > 0 && pages[pages.length - 1]!.length === 0 ? pages.slice(0, -1) : pages
}

async function storeWith(
  make: () => Promise<DocumentStoreAdapter>,
  generated: Generated[],
): Promise<{ store: DocumentStoreAdapter; docs: Doc[] }> {
  const store = await make()
  const docs = generated.map(stored)
  for (const doc of docs) await store.put<Doc>(COLLECTION, doc.id, doc)
  // Same keys, same partition, another collection: no query on COLLECTION may return them.
  for (const doc of docs.slice(0, 3)) {
    await store.put<Doc>(DECOY, doc.id, { ...doc, label: 'decoy' })
  }
  return { store, docs }
}

async function closing<T>(store: DocumentStoreAdapter, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } finally {
    await store.close()
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error ?? new Error('rejected with nothing'),
  )
}

const TTL_SECONDS = 1

export function documentStoreAcceptance(
  name: string,
  make: () => Promise<DocumentStoreAdapter>,
  opts: DocumentStoreAcceptanceOptions = {},
): void {
  describe(`P2-02 AC-2: ${name} agrees with the reference model (decision 3)`, () => {
    it(
      'AC-2: every query’s page sequence equals the reference: filter by partition and sortKey, order with nulls last and ties by key, slice by limit',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            docsArb(0),
            fc.constantFrom<'p' | '*'>('p', '*'),
            sortKeyArb,
            orderByArb,
            fc.integer({ min: 1, max: 5 }),
            async (generated, partition, sortKey, orderBy, limit) => {
              const { store, docs } = await storeWith(make, generated)
              await closing(store, async () => {
                const q: Query = { partition, sortKey, orderBy }
                const expected = reference(docs, q)
                const { pages, ended } = await walk(store, q, limit, docs.length + 2)

                expect(ended, 'the cursor walk never ended').toBe(true)
                for (const page of pages) expect(page.length).toBeLessThanOrEqual(limit)
                expect(withoutTrailingEmpty(pages.map(idsOf))).toEqual(chunk(expected, limit))
                const byId = new Map(docs.map((d) => [d.id, d]))
                for (const item of pages.flat()) expect(item).toEqual(byId.get(item.id))
              })
            },
          ),
          { numRuns: 50 },
        )
      },
      SLOW,
    )

    it(
      'AC-2: without orderBy, a cursor walk returns exactly the reference’s matches, each once',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            docsArb(0),
            fc.constantFrom<'p' | '*'>('p', '*'),
            sortKeyArb,
            fc.integer({ min: 1, max: 5 }),
            async (generated, partition, sortKey, limit) => {
              const { store, docs } = await storeWith(make, generated)
              await closing(store, async () => {
                const q: Query = { partition, sortKey, orderBy: undefined }
                const { pages, ended } = await walk(store, q, limit, docs.length + 2)
                const walked = idsOf(pages.flat())

                expect(ended, 'the cursor walk never ended').toBe(true)
                expect(walked.length, `duplicates in ${walked.join(',')}`).toBe(
                  new Set(walked).size,
                )
                expect([...walked].sort()).toEqual(reference(docs, q))
              })
            },
          ),
          { numRuns: 40 },
        )
      },
      SLOW,
    )

    it(
      'AC-2: a cursor walk across a mid-walk delete returns every remaining match exactly once, in the reference order',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            docsArb(3),
            fc.option(orderByArb, { nil: undefined }),
            fc.integer({ min: 1, max: 3 }),
            fc.nat(),
            async (generated, orderBy, limit, pick) => {
              const { store, docs } = await storeWith(make, generated)
              await closing(store, async () => {
                const q: Query = { partition: '*', sortKey: undefined, orderBy }
                const expected = reference(docs, q)
                fc.pre(expected.length > limit)
                // Any match: one already returned, the last one returned (the cursor's anchor), or one still ahead.
                const deleted = expected[pick % expected.length]!
                const { pages, ended } = await walk(store, q, limit, docs.length + 2, async (n) => {
                  if (n === 1) await store.delete(COLLECTION, deleted)
                })
                const walked = idsOf(pages.flat())

                expect(ended, 'the cursor walk never ended').toBe(true)
                expect(walked.length, `duplicates in ${walked.join(',')}`).toBe(
                  new Set(walked).size,
                )
                expect(walked.filter((id) => !expected.includes(id))).toEqual([])
                expect(expected.filter((id) => id !== deleted && !walked.includes(id))).toEqual([])
                if (orderBy !== undefined) {
                  expect(walked).toEqual(expected.filter((id) => walked.includes(id)))
                }
              })
            },
          ),
          { numRuns: 50 },
        )
      },
      SLOW,
    )

    it(
      'AC-2: a cursor issued under one orderBy is refused under another, and continues the walk under its own',
      async () => {
        const generated: Generated[] = ['k1', 'k2', 'k3', 'k4', 'k5'].map((key, i) => ({
          key,
          part: 'p',
          v: 5 - i,
          n: i,
        }))
        const { store, docs } = await storeWith(make, generated)
        await closing(store, async () => {
          const asc: Query = {
            partition: 'p',
            sortKey: undefined,
            orderBy: { field: 'v', direction: 'asc' },
          }
          const first = await store.query<Doc>(COLLECTION, params(asc, 2))
          expect(first.nextCursor).not.toBeNull()
          const cursor = first.nextCursor!

          const otherDirection = { ...asc, orderBy: { field: 'v', direction: 'desc' as const } }
          const otherField = { ...asc, orderBy: { field: 'nested.v', direction: 'asc' as const } }
          expect(
            await rejection(store.query(COLLECTION, params(otherDirection, 2, cursor))),
          ).toBeInstanceOf(Error)
          expect(
            await rejection(store.query(COLLECTION, params(otherField, 2, cursor))),
          ).toBeInstanceOf(Error)
          const next = await store.query<Doc>(COLLECTION, params(asc, 2, cursor))
          expect(idsOf(next.items)).toEqual(reference(docs, asc).slice(2, 4))
        })
      },
      SLOW,
    )

    it(
      'AC-2: a document put with a TTL is returned until it expires, then by no get, query or batchGet; one put without stays',
      async () => {
        const store = await make()
        await closing(store, async () => {
          const short: Doc = { id: 'short', part: 'p', nested: {}, label: 'ttl' }
          const long: Doc = { id: 'long', part: 'p', nested: {}, label: 'no ttl' }
          const putAt = Date.now()
          await store.put<Doc>(COLLECTION, short.id, short, { ttl: TTL_SECONDS })
          await store.put<Doc>(COLLECTION, long.id, long)
          expect(await store.get<Doc>(COLLECTION, short.id)).toEqual(short)

          if (opts.clock !== undefined) {
            await opts.clock.advance(TTL_SECONDS * 1000 - 1)
            expect(await store.get<Doc>(COLLECTION, short.id)).toEqual(short)
            await opts.clock.advance(2)
          } else {
            // Polled, not slept: the TTL is the store's to keep, and its expiry is read back as soon as it shows.
            const deadline = putAt + TTL_SECONDS * 1000 + 3000
            while ((await store.get(COLLECTION, short.id)) !== null && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 25))
            }
            expect(Date.now() - putAt, 'expired before its TTL').toBeGreaterThanOrEqual(
              TTL_SECONDS * 1000 - 100,
            )
          }

          expect(await store.get(COLLECTION, short.id)).toBeNull()
          const all = await store.query<Doc>(COLLECTION, {
            partitionKey: { field: 'part', value: '*' },
            limit: 100,
          })
          expect(idsOf(all.items)).toEqual([long.id])
          const batch = await store.batchGet<Doc>(COLLECTION, [short.id, long.id])
          expect([...batch.keys()]).toEqual([long.id])
        })
      },
      SLOW,
    )

    it('AC-2: a conditional put applies when the field matches, and otherwise fails condition-failed and changes nothing', async () => {
      const store = await make()
      await closing(store, async () => {
        const v1: Doc & { version: number } = {
          id: 'c',
          part: 'p',
          nested: {},
          label: 'v1',
          version: 1,
        }
        const v2 = { ...v1, label: 'v2', version: 2 }
        await store.put(COLLECTION, 'c', v1)

        await store.put(COLLECTION, 'c', v2, { conditionKey: 'version', conditionValue: 1 })
        expect(await store.get(COLLECTION, 'c')).toEqual(v2)

        const stale = await rejection(
          store.put(
            COLLECTION,
            'c',
            { ...v1, label: 'v3', version: 3 },
            { conditionKey: 'version', conditionValue: 1 },
          ),
        )
        expect((stale as { code?: unknown } | null)?.code).toBe('adapter.condition-failed')
        expect(await store.get(COLLECTION, 'c')).toEqual(v2)

        const absent = await rejection(
          store.put(COLLECTION, 'none', v1, { conditionKey: 'version', conditionValue: 1 }),
        )
        expect((absent as { code?: unknown } | null)?.code).toBe('adapter.condition-failed')
        expect(await store.get(COLLECTION, 'none')).toBeNull()
      })
    })

    it(
      'AC-2: batchPut stores every item and batchGet returns exactly the stored keys, equal to what was put',
      async () => {
        await fc.assert(
          fc.asyncProperty(docsArb(1), async (generated) => {
            const store = await make()
            await closing(store, async () => {
              const docs = generated.map(stored)
              await store.batchPut(COLLECTION, new Map(docs.map((d) => [d.id, d])))
              const asked = [...docs.map((d) => d.id), 'p2-02-absent']
              const got = await store.batchGet<Doc>(COLLECTION, asked)

              expect(got.size).toBe(docs.length)
              for (const doc of docs) {
                expect(got.get(doc.id)).toEqual(doc)
                expect(await store.get<Doc>(COLLECTION, doc.id)).toEqual(doc)
              }
            })
          }),
          { numRuns: 15 },
        )
      },
      SLOW,
    )

    it('AC-2: collections are isolated for get, query and delete', async () => {
      const store = await make()
      await closing(store, async () => {
        const a: Doc = { id: 'same', part: 'p', nested: {}, label: 'A' }
        const b: Doc = { ...a, label: 'B' }
        const onlyA: Doc = { ...a, id: 'only-a' }
        await store.put('p2-02-col-a', a.id, a)
        await store.put('p2-02-col-a', onlyA.id, onlyA)
        await store.put('p2-02-col-b', b.id, b)

        expect(await store.get('p2-02-col-a', 'same')).toEqual(a)
        expect(await store.get('p2-02-col-b', 'same')).toEqual(b)
        const inB = await store.query<Doc>('p2-02-col-b', {
          partitionKey: { field: 'part', value: '*' },
          limit: 100,
        })
        expect(idsOf(inB.items)).toEqual([b.id])
        await store.delete('p2-02-col-a', 'same')
        expect(await store.get('p2-02-col-b', 'same')).toEqual(b)
        expect(await store.get('p2-02-col-a', 'only-a')).toEqual(onlyA)
      })
    })

    if (opts.isolation !== undefined) {
      const isolation = opts.isolation
      it('AC-2: two instances with different prefixes never see each other’s documents', async () => {
        const [one, two] = await isolation()
        try {
          const mine: Doc = { id: 'shared-key', part: 'p', nested: {}, label: 'one' }
          const theirs: Doc = { ...mine, label: 'two' }
          await one.put(COLLECTION, mine.id, mine)
          await one.put(COLLECTION, 'one-only', { ...mine, id: 'one-only' })
          await two.put(COLLECTION, theirs.id, theirs)

          expect(await one.get(COLLECTION, mine.id)).toEqual(mine)
          expect(await two.get(COLLECTION, theirs.id)).toEqual(theirs)
          expect(await two.get(COLLECTION, 'one-only')).toBeNull()
          const inTwo = await two.query<Doc>(COLLECTION, {
            partitionKey: { field: 'part', value: '*' },
            limit: 100,
          })
          expect(idsOf(inTwo.items)).toEqual([theirs.id])
          const batch = await two.batchGet<Doc>(COLLECTION, [mine.id, 'one-only'])
          expect([...batch.values()]).toEqual([theirs])

          await one.delete(COLLECTION, mine.id)
          expect(await two.get(COLLECTION, theirs.id)).toEqual(theirs)
        } finally {
          await one.close()
          await two.close()
        }
      })
    }
  })
}
