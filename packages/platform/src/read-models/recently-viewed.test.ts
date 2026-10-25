import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  RECENT_VIEWS_KEPT,
  merged,
  viewerKey,
  withView,
  type RecentlyViewedDoc,
} from './recently-viewed.js'

// AC-1 and AC-2: the pure fold of the recently-viewed read model. A viewer's list is every product it viewed, once,
// at its newest view, newest first (ties by productId, ascending), at most 12. Folding views one at a time with
// `withView` gives that list whatever the order of the views and however often each is repeated; `merged` gives the
// same list for the union of a visitor's and a customer's, under the customer.

interface View {
  viewer: string
  productId: string
  viewedAt: string
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const PRODUCTS = Array.from({ length: 20 }, (_, i) => `prod-${String(i).padStart(2, '0')}`)
const VIEWERS = ['visitor:v-1', 'visitor:v-2', 'customer:c-1']

// A narrow time range, so the same instant comes up for two products and the tie rule is exercised.
const at = fc
  .integer({ min: 0, max: 40 })
  .map((minute) => new Date(BASE + minute * 60_000).toISOString())

const view: fc.Arbitrary<View> = fc.record({
  viewer: fc.constantFrom(...VIEWERS),
  productId: fc.constantFrom(...PRODUCTS),
  viewedAt: at,
})

const views = fc.array(view, { maxLength: 60 })

/** The reference: per product its newest view, newest first, ties by productId, the first 12. */
function reference(of: Array<{ productId: string; viewedAt: string }>): RecentlyViewedDoc['items'] {
  const newest = new Map<string, string>()
  for (const v of of) {
    const held = newest.get(v.productId)
    if (held === undefined || v.viewedAt > held) newest.set(v.productId, v.viewedAt)
  }
  return [...newest]
    .map(([productId, viewedAt]) => ({ productId, viewedAt }))
    .sort((a, b) =>
      a.viewedAt === b.viewedAt
        ? a.productId.localeCompare(b.productId)
        : b.viewedAt.localeCompare(a.viewedAt),
    )
    .slice(0, RECENT_VIEWS_KEPT)
}

/** `withView` folded over `seq`, one document per viewer. */
function folded(seq: View[]): Map<string, RecentlyViewedDoc> {
  const docs = new Map<string, RecentlyViewedDoc>()
  for (const v of seq)
    docs.set(v.viewer, withView(docs.get(v.viewer) ?? null, v.viewer, v.productId, v.viewedAt))
  return docs
}

/** One viewer's document built by `withView` from views of its own. */
const docOf = (viewer: string): fc.Arbitrary<RecentlyViewedDoc | null> =>
  fc.option(
    fc
      .array(fc.record({ productId: fc.constantFrom(...PRODUCTS), viewedAt: at }), {
        minLength: 1,
        maxLength: 30,
      })
      .map(
        (seq) =>
          seq.reduce<RecentlyViewedDoc | null>(
            (doc, v) => withView(doc, viewer, v.productId, v.viewedAt),
            null,
          )!,
      ),
    { nil: null },
  )

describe('AC-1: the view fold', () => {
  it('AC-1: viewerKey files a visitor under visitor:<id> and a customer under customer:<id>, so the two never share a document', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        const visitor = viewerKey({ kind: 'visitor', id })
        const customer = viewerKey({ kind: 'customer', id })
        expect([visitor, customer]).toEqual([`visitor:${id}`, `customer:${id}`])
        expect(visitor).not.toBe(customer)
      }),
    )
  })

  it('AC-1: property: for any sequence of views, withView folded over it gives each viewer every product once at its newest viewedAt, newest first, ties by productId, at most 12, equal to the reference fold over the whole sequence', () => {
    fc.assert(
      fc.property(views, (seq) => {
        const docs = folded(seq)
        expect([...docs.keys()].sort()).toEqual([...new Set(seq.map((v) => v.viewer))].sort())
        for (const [viewer, doc] of docs) {
          expect(doc.viewer).toBe(viewer)
          expect(doc.items, viewer).toEqual(reference(seq.filter((v) => v.viewer === viewer)))
          expect(doc.items.length).toBeLessThanOrEqual(RECENT_VIEWS_KEPT)
          expect(new Set(doc.items.map((i) => i.productId)).size).toBe(doc.items.length)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-1: property: any permutation of the views and any repetition of them (a redelivery, an out-of-order delivery) folds to the same documents', () => {
    fc.assert(
      fc.property(
        views.chain((seq) =>
          fc.tuple(
            fc.constant(seq),
            fc.shuffledSubarray(seq, { minLength: seq.length, maxLength: seq.length }),
            fc.subarray(seq).chain((again) =>
              fc.shuffledSubarray([...seq, ...again], {
                minLength: seq.length + again.length,
                maxLength: seq.length + again.length,
              }),
            ),
          ),
        ),
        ([seq, permuted, repeated]) => {
          const once = Object.fromEntries(folded(seq))
          expect(Object.fromEntries(folded(permuted)), 'permuted').toEqual(once)
          expect(Object.fromEntries(folded(repeated)), 'repeated').toEqual(once)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: a thirteenth product drops the oldest, and a view of a product already held moves it to the front without adding an entry', () => {
    const viewer = 'visitor:v-1'
    let doc: RecentlyViewedDoc | null = null
    for (let i = 0; i <= RECENT_VIEWS_KEPT; i += 1) {
      doc = withView(doc, viewer, PRODUCTS[i]!, new Date(BASE + i * 60_000).toISOString())
    }
    expect(doc!.items.map((i) => i.productId)).toEqual(
      PRODUCTS.slice(1, RECENT_VIEWS_KEPT + 1).reverse(),
    )

    const before = doc!.items.length
    const again = withView(doc, viewer, PRODUCTS[5]!, new Date(BASE + 99 * 60_000).toISOString())
    expect(again.items.length).toBe(before)
    expect(again.items[0]).toEqual({
      productId: PRODUCTS[5],
      viewedAt: new Date(BASE + 99 * 60_000).toISOString(),
    })
    expect(again.items.slice(1).map((i) => i.productId)).toEqual(
      doc!.items.map((i) => i.productId).filter((p) => p !== PRODUCTS[5]),
    )
  })
})

describe('AC-2: the merge at sign-in', () => {
  const VISITOR = 'visitor:v-merge'
  const CUSTOMER = 'customer:c-merge'

  it('AC-2: property: merged(visitor, customer) is the top 12 of their union at each product’s newest view under the customer key; visitor missing gives the customer’s unchanged, customer missing the visitor’s items under the customer key, neither null', () => {
    fc.assert(
      fc.property(docOf(VISITOR), docOf(CUSTOMER), (visitor, customer) => {
        const result = merged(visitor, customer, CUSTOMER)
        const expected =
          visitor === null
            ? customer
            : customer === null
              ? { viewer: CUSTOMER, items: visitor.items }
              : { viewer: CUSTOMER, items: reference([...visitor.items, ...customer.items]) }
        expect(result).toEqual(expected)
        const items = result?.items ?? []
        expect(items.length).toBeLessThanOrEqual(RECENT_VIEWS_KEPT)
        expect(new Set(items.map((i) => i.productId)).size).toBe(items.length)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-2: property: merging is folding the visitor’s views into the customer’s list: merged equals withView applied to the customer’s document for each of the visitor’s entries', () => {
    fc.assert(
      fc.property(docOf(VISITOR), docOf(CUSTOMER), (visitor, customer) => {
        fc.pre(visitor !== null)
        const byFold = visitor!.items.reduce<RecentlyViewedDoc | null>(
          (doc, i) => withView(doc, CUSTOMER, i.productId, i.viewedAt),
          customer,
        )
        expect(merged(visitor, customer, CUSTOMER)).toEqual(byFold)
      }),
      { numRuns: 200 },
    )
  })
})
