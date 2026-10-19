import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { InMemoryDocumentStore } from '@nymbalhq/platform'
import type { DocumentStoreAdapter } from '@nymbalhq/types'

runDocumentStoreContract(() => new InMemoryDocumentStore({ sweepIntervalMs: 0 }))

// P1-11 AC-5: `QueryParams.orderBy` orders without filtering (asc, desc, a dotted field, `nulls: 'last'`), and a cursor
// issued under an order continues that order. Generated keys make key order unrelated to value order, so a store that
// ignores `orderBy` and returns key order fails. Kills: orderBy ignored, direction ignored, the dotted path read as one
// literal key, nulls placed first, a cursor that restarts, skips or repeats under a non-key order.
//
// These cases belong in `runDocumentStoreContract` (packages/contract-tests/src/document-store.ts) so every
// document-store adapter runs them; they use nothing but `DocumentStoreAdapter` and `build`.

interface Doc {
  id: string
  group: string
  rank: number
  nested: { price: number | null }
}

type Direction = 'asc' | 'desc'

const COLLECTION = 'ordered'
const PARTITION = { field: 'group', value: 'g' }

const docsArb = fc.uniqueArray(
  fc.record({
    id: fc.stringMatching(/^[a-z0-9]{1,6}$/),
    rank: fc.integer({ min: 0, max: 5 }),
    price: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
  }),
  { minLength: 1, maxLength: 12, selector: (d) => d.id },
)
const directionArb = fc.constantFrom<Direction>('asc', 'desc')

type Generated = Array<{ id: string; rank: number; price: number | null }>

async function storeWith(build: () => DocumentStoreAdapter, docs: Generated) {
  const store = build()
  for (const d of docs) {
    await store.put<Doc>(COLLECTION, d.id, {
      id: d.id,
      group: 'g',
      rank: d.rank,
      nested: { price: d.price },
    })
  }
  // A document in another partition, which no query on PARTITION may return.
  await store.put<Doc>(COLLECTION, 'other', {
    id: 'other',
    group: 'h',
    rank: 0,
    nested: { price: 0 },
  })
  return store
}

const ids = (items: Doc[]) => items.map((d) => d.id)

/** Adjacent values are in `direction` order. */
function expectOrdered(values: number[], direction: Direction): void {
  for (let i = 1; i < values.length; i++) {
    if (direction === 'asc') expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    else expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!)
  }
}

function runOrderingContract(build: () => DocumentStoreAdapter): void {
  describe('DocumentStoreAdapter orderBy contract (P1-11)', () => {
    it('AC-5: orderBy asc and desc order a partition by the field, returning every document once', async () => {
      await fc.assert(
        fc.asyncProperty(docsArb, directionArb, async (docs, direction) => {
          const store = await storeWith(build, docs)
          try {
            const result = await store.query<Doc>(COLLECTION, {
              partitionKey: PARTITION,
              orderBy: { field: 'rank', direction },
              limit: 1000,
            })
            expect([...ids(result.items)].sort()).toEqual(docs.map((d) => d.id).sort())
            expectOrdered(
              result.items.map((d) => d.rank),
              direction,
            )
          } finally {
            await store.close()
          }
        }),
        { numRuns: 60 },
      )
    })

    it("AC-5: orderBy on a dotted field with nulls: 'last' puts every null after every value, in both directions", async () => {
      await fc.assert(
        fc.asyncProperty(docsArb, directionArb, async (docs, direction) => {
          const store = await storeWith(build, docs)
          try {
            const result = await store.query<Doc>(COLLECTION, {
              partitionKey: PARTITION,
              orderBy: { field: 'nested.price', direction, nulls: 'last' },
              limit: 1000,
            })
            expect([...ids(result.items)].sort()).toEqual(docs.map((d) => d.id).sort())
            const prices = result.items.map((d) => d.nested.price)
            const valued = prices.filter((p): p is number => p !== null)
            // Every value first, then every null.
            expect(prices.slice(0, valued.length)).toEqual(valued)
            expect(prices.length - valued.length).toBe(docs.filter((d) => d.price === null).length)
            expectOrdered(valued, direction)
          } finally {
            await store.close()
          }
        }),
        { numRuns: 60 },
      )
    })

    it('AC-5: following nextCursor under an orderBy yields the single-query order exactly, with no duplicate and no gap', async () => {
      await fc.assert(
        fc.asyncProperty(
          docsArb,
          directionArb,
          fc.constantFrom('rank', 'nested.price'),
          fc.integer({ min: 1, max: 4 }),
          async (docs, direction, field, limit) => {
            const store = await storeWith(build, docs)
            try {
              const orderBy = { field, direction, nulls: 'last' as const }
              const whole = await store.query<Doc>(COLLECTION, {
                partitionKey: PARTITION,
                orderBy,
                limit: 1000,
              })
              const paged: Doc[] = []
              let cursor: string | undefined
              let pages = 0
              do {
                const page = await store.query<Doc>(COLLECTION, {
                  partitionKey: PARTITION,
                  orderBy,
                  limit,
                  ...(cursor !== undefined && { cursor }),
                })
                expect(page.items.length).toBeLessThanOrEqual(limit)
                paged.push(...page.items)
                cursor = page.nextCursor ?? undefined
                pages += 1
              } while (cursor !== undefined && pages <= docs.length + 1)

              expect(cursor, 'the cursor walk never ended').toBeUndefined()
              expect(ids(paged)).toEqual(ids(whole.items))
              const values = whole.items.map((d) => (field === 'rank' ? d.rank : d.nested.price))
              const valued = values.filter((v): v is number => v !== null)
              expect(values.slice(0, valued.length)).toEqual(valued)
              expectOrdered(valued, direction)
            } finally {
              await store.close()
            }
          },
        ),
        { numRuns: 60 },
      )
    })
  })
}

runOrderingContract(() => new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
