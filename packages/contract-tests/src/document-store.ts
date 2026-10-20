import { describe, expect, it } from 'vitest'
import type { DocumentStoreAdapter, QueryParams } from '@nymbalhq/types'

export interface DocumentStoreContractOptions {
  /** A clock the store reads: the TTL case advances it instead of waiting a one-second TTL out. */
  clock?: { advance(ms: number): void | Promise<void> }
  /** Two stores on one backend under different prefixes, for the prefix isolation case. */
  isolation?: () => Promise<[DocumentStoreAdapter, DocumentStoreAdapter]>
}

type Make = () => DocumentStoreAdapter | Promise<DocumentStoreAdapter>

interface Doc {
  id: string
  part: string
  v?: unknown
  nested?: { v?: unknown }
}

const SLOW = 30_000

async function using(make: Make, body: (store: DocumentStoreAdapter) => Promise<void>) {
  const store = await make()
  try {
    await body(store)
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

async function putAll(store: DocumentStoreAdapter, collection: string, docs: Doc[]) {
  for (const doc of docs) await store.put(collection, doc.id, doc)
}

const ids = (docs: Doc[]): string[] => docs.map((d) => d.id)

async function walk(
  store: DocumentStoreAdapter,
  collection: string,
  params: QueryParams,
  between?: (page: number) => Promise<void>,
): Promise<Doc[][]> {
  const pages: Doc[][] = []
  let cursor: string | undefined
  do {
    const page = await store.query<Doc>(collection, {
      ...params,
      ...(cursor !== undefined && { cursor }),
    })
    pages.push(page.items)
    cursor = page.nextCursor ?? undefined
    if (between !== undefined) await between(pages.length)
  } while (cursor !== undefined && pages.length < 100)
  return pages
}

/**
 * The document store contract every implementation runs: the reference order and filter of
 * `compareDocumentValues` and `matchesSortKey`, cursors that survive a delete, TTL, conditional puts, batches, and
 * isolation between collections (and, given `isolation`, between prefixes). `make` returns an empty store each time.
 */
export function runDocumentStoreContract(
  name: string,
  make: Make,
  opts: DocumentStoreContractOptions = {},
): void {
  describe(`DocumentStoreAdapter contract: ${name}`, () => {
    it('get is null for a missing key; put then get round-trips; a second put overwrites', async () => {
      await using(make, async (store) => {
        expect(await store.get('col', 'missing')).toBeNull()
        await store.put('col', 'k1', { name: 'test', value: 42, nested: { list: [1, 'two'] } })
        expect(await store.get('col', 'k1')).toEqual({
          name: 'test',
          value: 42,
          nested: { list: [1, 'two'] },
        })
        await store.put('col', 'k1', { v: 2 })
        expect(await store.get('col', 'k1')).toEqual({ v: 2 })
      })
    })

    it('delete removes the document, and deleting a missing key does not throw', async () => {
      await using(make, async (store) => {
        await store.put('col', 'k1', { v: 1 })
        await store.delete('col', 'k1')
        expect(await store.get('col', 'k1')).toBeNull()
        await expect(store.delete('col', 'nope')).resolves.toBeUndefined()
      })
    })

    it("query narrows by partition, and '*' returns the whole collection", async () => {
      await using(make, async (store) => {
        await putAll(store, 'col', [
          { id: 'a', part: 'p' },
          { id: 'b', part: 'q' },
          { id: 'c', part: 'p' },
        ])
        const p = await store.query<Doc>('col', { partitionKey: { field: 'part', value: 'p' } })
        expect(ids(p.items).sort()).toEqual(['a', 'c'])
        const all = await store.query<Doc>('col', { partitionKey: { field: 'part', value: '*' } })
        expect(ids(all.items).sort()).toEqual(['a', 'b', 'c'])
        expect(all.nextCursor).toBeNull()
      })
    })

    it("sortKey eq is strict (1 is not '1', 'a' is not 'A'); gt, lt and between follow compareDocumentValues", async () => {
      await using(make, async (store) => {
        await putAll(store, 'col', [
          { id: 'n1', part: 'p', v: 1 },
          { id: 's1', part: 'p', v: '1' },
          { id: 'n5', part: 'p', v: 5 },
          { id: 'sa', part: 'p', v: 'a' },
          { id: 'sA', part: 'p', v: 'A' },
          { id: 'nul', part: 'p', v: null },
        ])
        const where = async (sortKey: NonNullable<QueryParams['sortKey']>) =>
          ids(
            (
              await store.query<Doc>('col', {
                partitionKey: { field: 'part', value: 'p' },
                sortKey,
              })
            ).items,
          ).sort()
        expect(await where({ field: 'v', operator: 'eq', value: 1 })).toEqual(['n1'])
        expect(await where({ field: 'v', operator: 'eq', value: 'a' })).toEqual(['sa'])
        // Numbers rank before strings, strings before null; 'A' and 'a' tie at base sensitivity.
        expect(await where({ field: 'v', operator: 'lt', value: '0' })).toEqual(['n1', 'n5'])
        expect(await where({ field: 'v', operator: 'gt', value: 5 })).toEqual(
          ['nul', 's1', 'sA', 'sa'].sort(),
        )
        expect(await where({ field: 'v', operator: 'between', value: [2, 'a'] })).toEqual(
          ['n5', 's1', 'sA', 'sa'].sort(),
        )
      })
    })

    it('orderBy orders by value with the collator, nulls and missing last, ties by key, on a dotted path too', async () => {
      await using(make, async (store) => {
        await putAll(store, 'col', [
          { id: 'k4', part: 'p', nested: { v: 'b' } },
          { id: 'k1', part: 'p', nested: { v: 'B' } },
          { id: 'k2', part: 'p', nested: { v: 'a' } },
          { id: 'k3', part: 'p', nested: {} },
          { id: 'k5', part: 'p', nested: { v: 10 } },
          { id: 'k6', part: 'p', nested: { v: 9 } },
          { id: 'k0', part: 'p', nested: { v: null } },
        ])
        const asc = await store.query<Doc>('col', {
          partitionKey: { field: 'part', value: 'p' },
          orderBy: { field: 'nested.v', direction: 'asc', nulls: 'last' },
        })
        expect(ids(asc.items)).toEqual(['k6', 'k5', 'k2', 'k1', 'k4', 'k0', 'k3'])
        const desc = await store.query<Doc>('col', {
          partitionKey: { field: 'part', value: 'p' },
          orderBy: { field: 'nested.v', direction: 'desc', nulls: 'last' },
        })
        expect(ids(desc.items)).toEqual(['k1', 'k4', 'k2', 'k5', 'k6', 'k0', 'k3'])
      })
    })

    it(
      'a limit and cursor walk returns every match exactly once, also when a document is deleted mid-walk',
      async () => {
        await using(make, async (store) => {
          const docs = Array.from({ length: 9 }, (_, i) => ({ id: `k${i}`, part: 'p', v: i % 3 }))
          await putAll(store, 'col', docs)
          for (const orderBy of [undefined, { field: 'v', direction: 'asc' as const }]) {
            const params: QueryParams = {
              partitionKey: { field: 'part', value: 'p' },
              limit: 2,
              ...(orderBy !== undefined && { orderBy }),
            }
            const whole = (await walk(store, 'col', params)).flat()
            expect(ids(whole).sort()).toEqual(ids(docs).sort())

            // The first cursor's anchor is deleted after the first page: the walk neither restarts nor repeats.
            const anchor = whole[1]!
            const walked = (
              await walk(store, 'col', params, async (page) => {
                if (page === 1) await store.delete('col', anchor.id)
              })
            ).flat()
            expect(new Set(ids(walked)).size).toBe(walked.length)
            expect(ids(walked).sort()).toEqual(ids(docs).sort())
            await store.put('col', anchor.id, anchor)
          }
        })
      },
      SLOW,
    )

    it('a cursor issued under one orderBy is refused under another, and continues under its own', async () => {
      await using(make, async (store) => {
        await putAll(
          store,
          'col',
          Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, part: 'p', v: i })),
        )
        const base: QueryParams = {
          partitionKey: { field: 'part', value: 'p' },
          orderBy: { field: 'v', direction: 'asc' },
          limit: 2,
        }
        const first = await store.query<Doc>('col', base)
        expect(first.nextCursor).not.toBeNull()
        const cursor = first.nextCursor!
        const other = await rejection(
          store.query('col', { ...base, orderBy: { field: 'v', direction: 'desc' }, cursor }),
        )
        expect(other).toBeInstanceOf(Error)
        const next = await store.query<Doc>('col', { ...base, cursor })
        expect(ids(next.items)).toEqual(['k2', 'k3'])
      })
    })

    it(
      'a document put with a ttl (seconds) is gone from get, query and batchGet once it expires',
      async () => {
        await using(make, async (store) => {
          await store.put('col', 'short', { id: 'short', part: 'p' }, { ttl: 1 })
          await store.put('col', 'kept', { id: 'kept', part: 'p' })
          expect(await store.get('col', 'short')).toEqual({ id: 'short', part: 'p' })
          if (opts.clock !== undefined) {
            await opts.clock.advance(1_001)
          } else {
            const deadline = Date.now() + 4_000
            while ((await store.get('col', 'short')) !== null && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50))
            }
          }
          expect(await store.get('col', 'short')).toBeNull()
          const all = await store.query<Doc>('col', { partitionKey: { field: 'part', value: '*' } })
          expect(ids(all.items)).toEqual(['kept'])
          expect([...(await store.batchGet('col', ['short', 'kept'])).keys()]).toEqual(['kept'])
        })
      },
      SLOW,
    )

    it('a conditional put applies when the field is strictly equal, and otherwise fails condition-failed', async () => {
      await using(make, async (store) => {
        await store.put('col', 'c', { version: 1, label: 'v1' })
        await store.put(
          'col',
          'c',
          { version: 2, label: 'v2' },
          { conditionKey: 'version', conditionValue: 1 },
        )
        expect(await store.get('col', 'c')).toEqual({ version: 2, label: 'v2' })
        for (const conditionValue of [1, '2']) {
          const failed = await rejection(
            store.put('col', 'c', { version: 3 }, { conditionKey: 'version', conditionValue }),
          )
          expect((failed as { code?: unknown } | null)?.code).toBe('adapter.condition-failed')
        }
        const absent = await rejection(
          store.put('col', 'none', { version: 1 }, { conditionKey: 'version', conditionValue: 1 }),
        )
        expect((absent as { code?: unknown } | null)?.code).toBe('adapter.condition-failed')
        expect(await store.get('col', 'c')).toEqual({ version: 2, label: 'v2' })
        expect(await store.get('col', 'none')).toBeNull()
      })
    })

    it('batchPut stores every item; batchGet returns exactly the stored keys', async () => {
      await using(make, async (store) => {
        await store.batchPut(
          'col',
          new Map([
            ['x', { n: 10 }],
            ['y', { n: 20 }],
          ]),
        )
        const got = await store.batchGet<{ n: number }>('col', ['x', 'y', 'missing'])
        expect([...got.keys()].sort()).toEqual(['x', 'y'])
        expect(got.get('x')).toEqual({ n: 10 })
        expect(await store.get('col', 'y')).toEqual({ n: 20 })
        expect((await store.batchGet('col', [])).size).toBe(0)
      })
    })

    it('collections are isolated for get, query and delete', async () => {
      await using(make, async (store) => {
        await store.put('colA', 'key', { id: 'key', part: 'p', from: 'A' })
        await store.put('colB', 'key', { id: 'key', part: 'p', from: 'B' })
        expect(await store.get('colA', 'key')).toEqual({ id: 'key', part: 'p', from: 'A' })
        const inB = await store.query('colB', { partitionKey: { field: 'part', value: '*' } })
        expect(inB.items).toEqual([{ id: 'key', part: 'p', from: 'B' }])
        await store.delete('colA', 'key')
        expect(await store.get('colB', 'key')).toEqual({ id: 'key', part: 'p', from: 'B' })
      })
    })

    const isolation = opts.isolation
    if (isolation !== undefined) {
      it('two stores under different prefixes never see each other’s documents', async () => {
        const [one, two] = await isolation()
        try {
          await one.put('col', 'shared', { id: 'shared', part: 'p', owner: 'one' })
          await one.put('col', 'one-only', { id: 'one-only', part: 'p', owner: 'one' })
          await two.put('col', 'shared', { id: 'shared', part: 'p', owner: 'two' })
          expect(await one.get('col', 'shared')).toEqual({ id: 'shared', part: 'p', owner: 'one' })
          expect(await two.get('col', 'one-only')).toBeNull()
          const inTwo = await two.query('col', { partitionKey: { field: 'part', value: '*' } })
          expect(inTwo.items).toEqual([{ id: 'shared', part: 'p', owner: 'two' }])
          await one.delete('col', 'shared')
          expect(await two.get('col', 'shared')).toEqual({ id: 'shared', part: 'p', owner: 'two' })
        } finally {
          await one.close()
          await two.close()
        }
      })
    }
  })
}
