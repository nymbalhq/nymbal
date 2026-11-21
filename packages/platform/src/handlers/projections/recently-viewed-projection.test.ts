import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { NymbalEvent } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { createEventBuilder } from '../../events/builder.js'
import { createLogger } from '../../logger.js'
import {
  RECENTLY_VIEWED,
  RECENT_VIEWS_KEPT,
  merged,
  withView,
  type RecentlyViewedDoc,
} from '../../read-models/recently-viewed.js'
import { TEST_BUILDER_CONTEXT } from '../../tests/publisher.js'
import { recentlyViewedProjection } from './recently-viewed-projection.js'

// AC-2's projection half: the live handlers keep `recently-viewed` documents under `visitor:<id>` and
// `customer:<id>`. A view is folded with `withView` at its envelope's timestamp; `visitor.merged.v1` folds the
// visitor's views dated at or before the merge's timestamp into the customer's document with `merged`, and leaves the
// visitor's later views under the visitor (no document when there are none); `customer.deleted.v1` deletes the
// customer's. Every other viewer's document is left as it was. AC-12: delivered late, after views the log holds
// after it, and delivered twice, the merge leaves the documents the fold in log order leaves.

const logger = createLogger({ pretty: false, level: 'error' })
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

const BASE = Date.parse('2026-03-01T00:00:00.000Z')
const PRODUCTS = Array.from({ length: 16 }, (_, i) => `prod-${String(i).padStart(2, '0')}`)
const VISITORS = ['v-1', 'v-2'] as const
const CUSTOMERS = ['c-1', 'c-2'] as const

type Viewer = { kind: 'visitor' | 'customer'; id: string }

const viewer: fc.Arbitrary<Viewer> = fc.oneof(
  fc.constantFrom(...VISITORS).map((id) => ({ kind: 'visitor' as const, id })),
  fc.constantFrom(...CUSTOMERS).map((id) => ({ kind: 'customer' as const, id })),
)

const views = fc.array(
  fc.record({
    viewer,
    productId: fc.constantFrom(...PRODUCTS),
    minute: fc.integer({ min: 0, max: 60 }),
  }),
  { maxLength: 40 },
)

const keyOf = (v: Viewer): string => `${v.kind}:${v.id}`
const ALL_KEYS = [
  ...VISITORS.map((id) => `visitor:${id}`),
  ...CUSTOMERS.map((id) => `customer:${id}`),
]

function harness() {
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const handlers = recentlyViewedProjection({ documentStore, logger })
  async function handle(event: NymbalEvent<unknown>): Promise<void> {
    const subscribed = handlers.filter((h) => h.types.includes(event.type))
    if (subscribed.length === 0) throw new Error(`no recently-viewed handler for ${event.type}`)
    for (const h of subscribed) await h.handle(event)
  }
  async function docs(): Promise<Record<string, RecentlyViewedDoc | null>> {
    const out: Record<string, RecentlyViewedDoc | null> = {}
    for (const key of ALL_KEYS)
      out[key] = await documentStore.get<RecentlyViewedDoc>(RECENTLY_VIEWED, key)
    return out
  }
  return { documentStore, handlers, handle, docs }
}

async function viewAll(
  h: ReturnType<typeof harness>,
  seq: Array<{ viewer: Viewer; productId: string; minute: number }>,
): Promise<Record<string, RecentlyViewedDoc | null>> {
  const expected: Record<string, RecentlyViewedDoc | null> = Object.fromEntries(
    ALL_KEYS.map((k) => [k, null]),
  )
  for (const v of seq) {
    const viewedAt = new Date(BASE + v.minute * 60_000)
    await h.handle(
      makeEvent(
        'product.viewed.v1',
        { productId: v.productId, viewer: v.viewer },
        { timestamp: viewedAt },
      ) as NymbalEvent<unknown>,
    )
    const key = keyOf(v.viewer)
    expected[key] = withView(expected[key] ?? null, key, v.productId, viewedAt.toISOString())
  }
  return expected
}

// AC-12's log: the merged visitor's views on both sides of the merge, and other viewers' views at any time. The
// visitor's earlier and later views name disjoint products, at most RECENT_VIEWS_KEPT in all: a visitor document keeps
// one view per product, its newest, within the cap, so a later view projected before the merge would otherwise hide
// an earlier view of the same product from the merge.
const MERGED_VISITOR = VISITORS[0]
const MERGE_CUSTOMER = CUSTOMERS[0]
const EARLIER = PRODUCTS.slice(0, RECENT_VIEWS_KEPT / 2)
const LATER = PRODUCTS.slice(RECENT_VIEWS_KEPT / 2, RECENT_VIEWS_KEPT)

type LoggedView = { viewer: Viewer; productId: string; minute: number }

const mergeLog = fc.integer({ min: 0, max: 120 }).chain((mergeMinute) =>
  fc.record({
    mergeMinute: fc.constant(mergeMinute),
    earlier: fc.array(
      fc.record({
        productId: fc.constantFrom(...EARLIER),
        minute: fc.integer({ min: 0, max: mergeMinute }),
      }),
      { maxLength: 12 },
    ),
    later: fc.array(
      fc.record({
        productId: fc.constantFrom(...LATER),
        minute: fc.integer({ min: mergeMinute + 1, max: 181 }),
      }),
      { maxLength: 12 },
    ),
    others: fc.array(
      fc.record({
        viewer: fc.constantFrom<Viewer>(
          ...VISITORS.filter((id) => id !== MERGED_VISITOR).map((id) => ({
            kind: 'visitor' as const,
            id,
          })),
          ...CUSTOMERS.map((id) => ({ kind: 'customer' as const, id })),
        ),
        productId: fc.constantFrom(...PRODUCTS),
        minute: fc.integer({ min: 0, max: 181 }),
      }),
      { maxLength: 20 },
    ),
    // How many of the views the log holds after the merge are projected before its first delivery.
    lateBy: fc.nat(),
  }),
)

const viewEvent = (v: LoggedView): NymbalEvent<unknown> =>
  makeEvent(
    'product.viewed.v1',
    { productId: v.productId, viewer: v.viewer },
    { timestamp: new Date(BASE + v.minute * 60_000) },
  ) as NymbalEvent<unknown>

describe('AC-2: the recently-viewed projection', () => {
  it('AC-2: it subscribes to product.viewed.v1, visitor.merged.v1 and customer.deleted.v1', () => {
    const { handlers } = harness()
    expect([...new Set(handlers.flatMap((h) => [...h.types]))].sort()).toEqual(
      ['customer.deleted.v1', 'product.viewed.v1', 'visitor.merged.v1'].sort(),
    )
  })

  it('AC-2: property: views are folded under their viewer’s key at the envelope’s timestamp, as withView folds them', async () => {
    await fc.assert(
      fc.asyncProperty(views, async (seq) => {
        const h = harness()
        const expected = await viewAll(h, seq)
        expect(await h.docs()).toEqual(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('AC-2: property: visitor.merged.v1 stamped after every view writes merged(visitor, customer) under customer:<id>, leaves no visitor:<id>, and leaves every other viewer’s list', async () => {
    await fc.assert(
      fc.asyncProperty(
        views,
        fc.constantFrom(...VISITORS),
        fc.constantFrom(...CUSTOMERS),
        async (seq, visitorId, customerId) => {
          const h = harness()
          const before = await viewAll(h, seq)
          await h.handle(
            makeEvent('visitor.merged.v1', { visitorId, customerId }) as NymbalEvent<unknown>,
          )
          const after = await h.docs()
          const visitorKey = `visitor:${visitorId}`
          const customerKey = `customer:${customerId}`
          expect(after[customerKey], customerKey).toEqual(
            merged(before[visitorKey] ?? null, before[customerKey] ?? null, customerKey),
          )
          expect(after[visitorKey], `${visitorKey} after the merge`).toBeNull()
          for (const key of ALL_KEYS.filter((k) => k !== visitorKey && k !== customerKey)) {
            expect(after[key], key).toEqual(before[key])
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-2: property: a second delivery of the same visitor.merged.v1 changes nothing more', async () => {
    await fc.assert(
      fc.asyncProperty(views, async (seq) => {
        const h = harness()
        await viewAll(h, seq)
        const merge = makeEvent('visitor.merged.v1', {
          visitorId: VISITORS[0],
          customerId: CUSTOMERS[0],
        }) as NymbalEvent<unknown>
        await h.handle(merge)
        const once = await h.docs()
        await h.handle(merge)
        expect(await h.docs()).toEqual(once)
      }),
      { numRuns: 50 },
    )
  })

  it('AC-2: property: customer.deleted.v1 deletes customer:<id> and leaves every other viewer’s list', async () => {
    await fc.assert(
      fc.asyncProperty(views, fc.constantFrom(...CUSTOMERS), async (seq, customerId) => {
        const h = harness()
        const before = await viewAll(h, seq)
        await h.handle(makeEvent('customer.deleted.v1', { customerId }) as NymbalEvent<unknown>)
        const after = await h.docs()
        const deleted = `customer:${customerId}`
        expect(after[deleted], `${deleted} after the deletion`).toBeNull()
        for (const key of ALL_KEYS.filter((k) => k !== deleted)) {
          expect(after[key], key).toEqual(before[key])
        }
      }),
      { numRuns: 100 },
    )
  })
})

describe('AC-12: a sign-in merge delivered late', () => {
  it('AC-12: property: delivered after later views and twice, visitor.merged.v1 moves the views at or before its timestamp to the customer, keeps later ones with the visitor, and leaves what the log-order fold leaves', async () => {
    await fc.assert(
      fc.asyncProperty(mergeLog, async ({ mergeMinute, earlier, later, others, lateBy }) => {
        const visitor: Viewer = { kind: 'visitor', id: MERGED_VISITOR }
        const views: LoggedView[] = [
          ...earlier.map((v) => ({ ...v, viewer: visitor })),
          ...later.map((v) => ({ ...v, viewer: visitor })),
          ...others,
        ].sort((a, b) => a.minute - b.minute)
        const before = views.filter((v) => v.minute <= mergeMinute)
        const after = views.filter((v) => v.minute > mergeMinute)

        // The fold in log order: the views up to the merge, the merge, then the views after it.
        const expected: Record<string, RecentlyViewedDoc | null> = Object.fromEntries(
          ALL_KEYS.map((k) => [k, null]),
        )
        const fold = (v: LoggedView): void => {
          const key = keyOf(v.viewer)
          const at = new Date(BASE + v.minute * 60_000).toISOString()
          expected[key] = withView(expected[key] ?? null, key, v.productId, at)
        }
        const visitorKey = keyOf(visitor)
        const customerKey = `customer:${MERGE_CUSTOMER}`
        before.forEach(fold)
        expected[customerKey] = merged(
          expected[visitorKey] ?? null,
          expected[customerKey] ?? null,
          customerKey,
        )
        expected[visitorKey] = null
        after.forEach(fold)

        // Delivered: the merge after `lateBy` of the later views, and again after all of them.
        const h = harness()
        const merge = makeEvent(
          'visitor.merged.v1',
          { visitorId: MERGED_VISITOR, customerId: MERGE_CUSTOMER },
          { timestamp: new Date(BASE + mergeMinute * 60_000) },
        ) as NymbalEvent<unknown>
        const early = lateBy % (after.length + 1)
        for (const v of before) await h.handle(viewEvent(v))
        for (const v of after.slice(0, early)) await h.handle(viewEvent(v))
        await h.handle(merge)
        for (const v of after.slice(early)) await h.handle(viewEvent(v))
        await h.handle(merge)

        expect(await h.docs()).toEqual(expected)
      }),
      { numRuns: 200 },
    )
  })
})
