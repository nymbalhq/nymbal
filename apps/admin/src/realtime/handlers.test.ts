import fc from 'fast-check'
import { QueryClient, QueryObserver, hashKey, type QueryKey } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Shared shapes, read from source: the admin depends on @nymbalhq/types.
import type { Order, OrderStatus } from '../../../../packages/types/src/index'
import { useNotifications } from '@/hooks/useNotifications'
import { createEventHandlers, resyncLiveQueries } from './handlers'

// AC-3 and AC-4: what the realtime handler does with real event payloads (packages/types/src/events/payloads.ts).

const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]

const address = {
  firstName: 'Avery',
  lastName: 'Quinn',
  addressLine1: '42 Harbour Lane',
  city: 'Bristol',
  region: 'Bristol',
  postalCode: 'BS1 4DJ',
  country: 'GB',
}

function order(id: string, status: OrderStatus, sequence: number): Order {
  return {
    id,
    orderNumber: `NYM-${1000 + sequence}`,
    sequence,
    customerId: null,
    status,
    email: `${id}@example.com`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [],
    subtotalMinor: 1000,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1000,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    capturedMinor: 0,
    capturedAt: null,
    refundedMinor: 0,
    captureMethod: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  }
}

/** The list filters of hooks/useOrders.ts; a key may be absent or present as undefined, both mean unset. */
interface Filters {
  status?: string | undefined
  dateFrom?: string | undefined
  dateTo?: string | undefined
  customer?: string | undefined
  q?: string | undefined
  sort?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
}

const unsetOr = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })

const anyFilters: fc.Arbitrary<Filters> = fc.record(
  {
    status: unsetOr(fc.constantFrom(...STATUSES)),
    dateFrom: unsetOr(fc.constant('2026-01-01')),
    dateTo: unsetOr(fc.constant('2026-12-31')),
    customer: unsetOr(fc.constantFrom('cust-1', 'avery@example.com')),
    q: unsetOr(fc.constantFrom('avery', 'NYM-1')),
    sort: unsetOr(fc.constantFrom('createdAt:desc', 'createdAt:asc', 'totalMinor:desc')),
    limit: unsetOr(fc.integer({ min: 1, max: 6 })),
    offset: unsetOr(fc.integer({ min: 0, max: 3 })),
  },
  { requiredKeys: [] },
)

// The shape the orders page asks for (OrdersListPage: status or all, newest first, a limit), so admitted lists are
// generated often rather than by chance.
const firstPageFilters: fc.Arbitrary<Filters> = fc.record(
  {
    status: unsetOr(fc.constantFrom(...STATUSES)),
    sort: fc.constantFrom(undefined, 'createdAt:desc'),
    limit: unsetOr(fc.integer({ min: 1, max: 6 })),
    offset: fc.constantFrom(undefined, 0),
    q: fc.constant(undefined),
  },
  { requiredKeys: [] },
)

const unset = (v: unknown): boolean => v === undefined

/** The admit predicate (AC-3), written out independently. */
function admits(f: Filters, s: OrderStatus): boolean {
  return (
    (unset(f.status) || f.status === s) &&
    unset(f.q) &&
    unset(f.dateFrom) &&
    unset(f.dateTo) &&
    unset(f.customer) &&
    (unset(f.offset) || f.offset === 0) &&
    (unset(f.sort) || f.sort === 'createdAt:desc')
  )
}

const listKey = (f: Filters) => ['orders', 'list', f] as const

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}

beforeEach(() => {
  useNotifications.getState().clearAll()
})

describe('AC-3: a placed order goes only into the lists whose filter admits it', () => {
  it('AC-3: written first, trimmed to limit and once into admitting lists; other lists its status admits are invalidated, not written; lists its status excludes are untouched (property)', async () => {
    const scenario = fc.record({
      status: fc.constantFrom(...STATUSES),
      filters: fc.uniqueArray(fc.oneof(firstPageFilters, anyFilters), {
        minLength: 1,
        maxLength: 5,
        selector: (f) => hashKey(listKey(f)),
      }),
      existing: fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 8 }),
      alreadyListed: fc.boolean(),
    })

    await fc.assert(
      fc.asyncProperty(scenario, async ({ status, filters, existing, alreadyListed }) => {
        const qc = freshClient()
        const placed = order('placed', status, 999)
        const stale = { ...order('placed', 'pending', 999), notes: 'an older copy' }
        const before = new Map<string, Order[]>()
        for (const f of filters) {
          const list = existing.map((n) => order(`o-${n}`, STATUSES[n % STATUSES.length]!, n))
          if (alreadyListed) list.splice(Math.min(1, list.length), 0, stale)
          qc.setQueryData(listKey(f), list)
          before.set(hashKey(listKey(f)), list)
        }

        createEventHandlers(qc)('order.placed.v1', { order: placed })

        for (const f of filters) {
          const key = listKey(f)
          const old = before.get(hashKey(key))!
          const now = qc.getQueryData<Order[]>(key)
          const label = JSON.stringify(f)
          const written = admits(f, status)
          const statusAdmits = unset(f.status) || f.status === status
          const expected = written
            ? [placed, ...old.filter((o) => o.id !== placed.id)].slice(0, f.limit ?? Infinity)
            : old
          expect(now, label).toEqual(expected)
          expect(now!.filter((o) => o.id === placed.id).length, label).toBe(
            written ? 1 : old.filter((o) => o.id === placed.id).length,
          )
          // A written list may or may not be marked stale; an unwritten one is stale iff its status admits the order.
          const invalidated = qc.getQueryState(key)?.isInvalidated
          expect(written ? statusAdmits : invalidated, label).toBe(statusAdmits)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('AC-3: other order events ({ orderId }) mark list and detail queries stale and never write a partial order into them (property)', async () => {
    type Handle = ReturnType<typeof createEventHandlers>
    const events: Array<[string, (handle: Handle, orderId: string) => void]> = [
      [
        'order.paid.v1',
        (h, orderId) =>
          h('order.paid.v1', {
            orderId,
            paymentIntentId: 'pi_1',
            amountMinor: 1000,
            currency: 'GBP',
          }),
      ],
      ['order.fulfilled.v1', (h, orderId) => h('order.fulfilled.v1', { orderId })],
      [
        'order.shipped.v1',
        (h, orderId) => h('order.shipped.v1', { orderId, trackingNumber: 'TRK-1', carrier: 'DHL' }),
      ],
      ['order.delivered.v1', (h, orderId) => h('order.delivered.v1', { orderId })],
      [
        'order.cancelled.v1',
        (h, orderId) => h('order.cancelled.v1', { orderId, reason: 'customer asked' }),
      ],
      [
        'order.refunded.v1',
        (h, orderId) => {
          // Refund payloads carry refundId and currency and no lineItems. Built apart from the call (no
          // excess-property check), so the payload is checked against the event map.
          const payload = {
            orderId,
            refundId: 'refund-1',
            amountMinor: 1000,
            currency: 'GBP',
            reason: 'returned',
          }
          h('order.refunded.v1', payload)
        },
      ],
      [
        'order.partially_refunded.v1',
        (h, orderId) => {
          const payload = {
            orderId,
            refundId: 'refund-2',
            amountMinor: 500,
            currency: 'GBP',
            lineItems: [],
            reason: 'one item',
          }
          h('order.partially_refunded.v1', payload)
        },
      ],
    ]

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...events),
        fc.uniqueArray(anyFilters, {
          minLength: 1,
          maxLength: 3,
          selector: (f) => hashKey(listKey(f)),
        }),
        fc.integer({ min: 1, max: 40 }),
        async ([type, fire], filters, n) => {
          const qc = freshClient()
          const target = order(`o-${n}`, 'pending', n)
          const list = [order('o-other', 'confirmed', 0), target]
          for (const f of filters) qc.setQueryData(listKey(f), list)
          const detailKey = ['orders', 'detail', target.orderNumber]
          const detail = { ...target, history: [] }
          qc.setQueryData(detailKey, detail)

          fire(createEventHandlers(qc), target.id)

          for (const f of filters) {
            expect(qc.getQueryData(listKey(f)), `${type} ${JSON.stringify(f)}`).toEqual(list)
            expect(qc.getQueryState(listKey(f))?.isInvalidated, `${type} list`).toBe(true)
          }
          expect(qc.getQueryData(detailKey), type).toEqual(detail)
          expect(qc.getQueryState(detailKey)?.isInvalidated, `${type} detail`).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('AC-4: notifications name what the payload carries', () => {
  // Prefixed so one generated value cannot contain another by accident; quantities and thresholds never overlap.
  const id = (prefix: string) => fc.stringMatching(/^[a-z0-9]{4,12}$/).map((s) => `${prefix}-${s}`)
  const latest = () => useNotifications.getState().notifications[0]
  const text = () => `${latest()?.title ?? ''} ${latest()?.message ?? ''}`

  it('AC-4: inventory.low_stock.v1 { variantId, currentQty, threshold } names the quantity and renders no undefined (property)', () => {
    fc.assert(
      fc.property(
        id('var'),
        fc.integer({ min: 1000, max: 4999 }),
        fc.integer({ min: 5000, max: 9999 }),
        (variantId, currentQty, threshold) => {
          useNotifications.getState().clearAll()
          createEventHandlers(freshClient())('inventory.low_stock.v1', {
            variantId,
            currentQty,
            threshold,
          })
          expect(useNotifications.getState().notifications).toHaveLength(1)
          expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/)
          expect(latest()!.message).toContain(String(currentQty))
        },
      ),
    )
  })

  it('AC-4: inventory.out_of_stock.v1 { variantId } produces a notification that renders no undefined (property)', () => {
    fc.assert(
      fc.property(id('var'), (variantId) => {
        useNotifications.getState().clearAll()
        createEventHandlers(freshClient())('inventory.out_of_stock.v1', { variantId })
        expect(useNotifications.getState().notifications).toHaveLength(1)
        expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/)
      }),
    )
  })

  it('AC-4: payment.failed.v1 { paymentId, orderId, reason } names the order and renders no undefined (property)', () => {
    fc.assert(
      fc.property(
        id('pay'),
        id('ord'),
        fc.constantFrom('card_declined', 'insufficient_funds'),
        (paymentId, orderId, reason) => {
          useNotifications.getState().clearAll()
          createEventHandlers(freshClient())('payment.failed.v1', { paymentId, orderId, reason })
          expect(useNotifications.getState().notifications).toHaveLength(1)
          expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/)
          expect(latest()!.message).toContain(orderId)
        },
      ),
    )
  })

  it('AC-4: adapter.error.v1 { adapterType, adapterName, error } names the adapter and renders no undefined (property)', () => {
    fc.assert(
      fc.property(
        id('adp'),
        fc.constantFrom('payments', 'email', 'search'),
        (adapterName, adapterType) => {
          useNotifications.getState().clearAll()
          createEventHandlers(freshClient())('adapter.error.v1', {
            adapterType,
            adapterName,
            error: { code: 'adapter.timeout', message: 'timed out' },
            context: {},
          })
          expect(useNotifications.getState().notifications).toHaveLength(1)
          expect(text()).not.toMatch(/undefined|NaN|\[object Object\]/)
          expect(latest()!.message).toContain(adapterName)
        },
      ),
    )
  })
})

/** A promise and the function that settles it, for a queryFn the test lets finish when it chooses. */
function deferred(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/** Waits, polling every millisecond, until no query in the cache is fetching. */
async function fetchesSettled(qc: QueryClient): Promise<void> {
  // A zero-delay yield, not a sleep: the promise chains the act started (a cancel, then the invalidate it settles
  // into) run first, so the poll cannot catch the idle instant between them.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await vi.waitFor(() => expect(qc.isFetching(), 'queries still fetching').toBe(0), {
    interval: 1,
    timeout: 2000,
  })
}

describe('AC-3: a reconnect resyncs exactly the queries the live handlers maintain', () => {
  const LIVE_PREFIXES: QueryKey[] = [
    ['orders', 'list'],
    ['orders', 'detail'],
    ['dashboard'],
    ['inventory', 'list'],
  ]
  const OTHER_PREFIXES: QueryKey[] = [
    ['products', 'list'],
    ['products', 'detail'],
    ['me'],
    ['settings'],
    ['orders', 'notes'],
    ['orders', 'timeline'],
    ['inventory', 'history'],
    ['customers', 'list'],
    ['activity'],
  ]

  const tailArb = fc.option(
    fc.oneof(
      anyFilters.map((f): unknown => f),
      fc.stringMatching(/^NYM-[0-9]{3,4}$/),
    ),
    { nil: undefined },
  )
  const entryArb = fc
    .record({
      live: fc.boolean(),
      prefix: fc.nat(),
      tail: tailArb,
      active: fc.boolean(),
    })
    .map(({ live, prefix, tail, active }) => {
      const prefixes = live ? LIVE_PREFIXES : OTHER_PREFIXES
      const base = prefixes[prefix % prefixes.length]!
      const queryKey: QueryKey = tail === undefined ? [...base] : [...base, tail]
      return { live, active, queryKey }
    })

  it('AC-3: resyncLiveQueries refetches every active live query, marks every inactive one stale, refetches a pending first fetch anew rather than joining it, and leaves every other query as it was (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(entryArb, {
          minLength: 1,
          maxLength: 10,
          selector: (e) => hashKey(e.queryKey),
        }),
        fc.constantFrom(...LIVE_PREFIXES),
        async (entries, pendingPrefix) => {
          const qc = freshClient()
          const unsubscribes: Array<() => void> = []
          const calls = new Map<string, number>()
          const observe = (queryKey: QueryKey, queryFn: () => Promise<unknown>) => {
            const observer = new QueryObserver(qc, { queryKey, queryFn, staleTime: Infinity })
            unsubscribes.push(observer.subscribe(() => {}))
          }

          for (const { queryKey, active } of entries) {
            const id = hashKey(queryKey)
            calls.set(id, 0)
            if (active) {
              observe(queryKey, async () => {
                const n = (calls.get(id) ?? 0) + 1
                calls.set(id, n)
                return { id, call: n }
              })
            } else {
              qc.setQueryData(queryKey, { id, call: 0 })
            }
          }
          await fetchesSettled(qc)

          // An active live query whose first GET read the rows before a new one was added, and has not answered yet.
          let rows = ['A']
          let pendingCalls = 0
          const firstGet = deferred()
          const pendingKey: QueryKey = [...pendingPrefix, { firstFetchPending: true }]
          observe(pendingKey, async () => {
            pendingCalls += 1
            const snapshot = [...rows]
            if (pendingCalls === 1) await firstGet.opened
            return snapshot
          })
          expect(qc.getQueryState(pendingKey)?.fetchStatus, 'first fetch in flight').toBe(
            'fetching',
          )
          rows = ['B', ...rows]

          const before = new Map(
            entries.map(({ queryKey }) => {
              const id = hashKey(queryKey)
              const state = qc.getQueryState(queryKey)!
              return [
                id,
                {
                  calls: calls.get(id)!,
                  dataUpdatedAt: state.dataUpdatedAt,
                  isInvalidated: state.isInvalidated,
                },
              ] as const
            }),
          )

          await resyncLiveQueries(qc)
          firstGet.open()
          await fetchesSettled(qc)

          const ids = (pick: (e: (typeof entries)[number]) => boolean) =>
            entries.filter(pick).map((e) => hashKey(e.queryKey))
          for (const id of ids((e) => e.live && e.active)) {
            expect(calls.get(id)!, `live active ${id}`).toBeGreaterThan(before.get(id)!.calls)
          }
          for (const id of ids((e) => e.live && !e.active)) {
            expect(qc.getQueryCache().get(id)!.state.isInvalidated, `live inactive ${id}`).toBe(
              true,
            )
          }
          for (const id of ids((e) => !e.live)) {
            const was = before.get(id)!
            const state = qc.getQueryCache().get(id)!.state
            expect(state.dataUpdatedAt, `other ${id}`).toBe(was.dataUpdatedAt)
            expect(state.isInvalidated, `other ${id}`).toBe(was.isInvalidated)
            expect(calls.get(id)!, `other ${id}: queryFn calls`).toBe(was.calls)
          }
          expect(pendingCalls, 'the pending first fetch was refetched, not joined').toBe(2)
          expect(qc.getQueryData(pendingKey), 'the second GET, which read the new row').toEqual(
            rows,
          )

          unsubscribes.forEach((unsubscribe) => unsubscribe())
          qc.clear()
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('AC-4: a placed order is not lost to a list fetch already in flight', () => {
  const PHASES = ['a refetch of a list with data', 'a first fetch with no data yet'] as const

  it('AC-4: an order placed while an admitting list is fetching is in that list exactly once after the GET that read before it settles; an idle list is still written in place (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STATUSES),
        fc.oneof(firstPageFilters, anyFilters),
        fc.boolean(),
        fc.constantFrom(...PHASES),
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 8 }),
        async (status, generated, anyStatus, phase, existing) => {
          const qc = freshClient()
          const placed = order('placed', status, 999)
          const filters: Filters = { ...generated, status: anyStatus ? undefined : status }
          const key = listKey(filters)

          // The server's page for these filters: an admitting list's page holds the order once it has committed.
          let committed = existing.map((n) => order(`o-${n}`, status, n))
          const serverPage = () => committed.slice(0, filters.limit ?? committed.length)

          let calls = 0
          const gatedCall = phase === PHASES[0] ? 2 : 1
          const inFlight = deferred()
          const observer = new QueryObserver<Order[]>(qc, {
            queryKey: key,
            staleTime: Infinity,
            queryFn: async () => {
              calls += 1
              const snapshot = serverPage()
              if (calls === gatedCall) await inFlight.opened
              return snapshot
            },
          })
          const unsubscribe = observer.subscribe(() => {})
          if (gatedCall === 2) {
            await fetchesSettled(qc)
            void observer.refetch()
          }
          expect(calls, `${phase}: the GET has read`).toBe(gatedCall)
          expect(qc.getQueryState(key)?.fetchStatus, phase).toBe('fetching')

          const idleKey = listKey({ offset: 0, limit: 99 })
          const idleBefore = existing.map((n) => order(`o-${n}`, status, n))
          qc.setQueryData(idleKey, idleBefore)

          // The order commits after the in-flight GET read, and its event arrives before that GET answers.
          committed = [placed, ...committed]
          createEventHandlers(qc)('order.placed.v1', { order: placed })
          expect(qc.getQueryData(idleKey), 'the idle list, written in place').toEqual([
            placed,
            ...idleBefore,
          ])

          inFlight.open()
          await fetchesSettled(qc)

          const final = qc.getQueryData<Order[]>(key) ?? []
          expect(
            final.filter((o) => o.id === placed.id).length,
            `${phase} ${JSON.stringify(filters)}: copies of the placed order`,
          ).toBe(serverPage().filter((o) => o.id === placed.id).length)

          unsubscribe()
          qc.clear()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-4: in a burst where every order arrives while the list is fetching, each row is in the list right after its event, and once the burst settles every order is in it exactly once (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...STATUSES),
        fc.boolean(),
        fc.constantFrom(undefined, 'createdAt:desc'),
        fc.constantFrom(undefined, 0),
        fc.integer({ min: 2, max: 8 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 5 }),
        async (status, anyStatus, sort, offset, k, existing) => {
          const qc = freshClient()
          // A first page the burst never pushes an order off, so every placed order belongs in it.
          const filters: Filters = { status: anyStatus ? undefined : status, sort, offset, limit: 50 }
          const key = listKey(filters)
          let committed = existing.map((n) => order(`o-${n}`, status, n))

          // The first GET answers at once; every later one is held until the burst is over.
          let calls = 0
          const held: Array<() => void> = []
          const observer = new QueryObserver<Order[]>(qc, {
            queryKey: key,
            staleTime: Infinity,
            queryFn: async () => {
              calls += 1
              const snapshot = [...committed]
              if (calls > 1) {
                const gate = deferred()
                held.push(gate.open)
                await gate.opened
              }
              return snapshot
            },
          })
          const unsubscribe = observer.subscribe(() => {})
          await fetchesSettled(qc)
          void observer.refetch()

          const handle = createEventHandlers(qc)
          const placed: Order[] = []
          for (let i = 0; i < k; i++) {
            expect(qc.getQueryState(key)?.fetchStatus, `order ${i}: a GET in flight`).toBe(
              'fetching',
            )
            const next = order(`placed-${i}`, status, 1000 + i)
            committed = [next, ...committed]
            placed.push(next)
            handle('order.placed.v1', { order: next })

            const now = qc.getQueryData<Order[]>(key) ?? []
            expect(now[0]?.id, `order ${i}: heads the list right after its event`).toBe(next.id)
            for (const p of placed) {
              expect(
                now.filter((o) => o.id === p.id).length,
                `order ${i}: copies of ${p.id}`,
              ).toBe(1)
            }
            // The refetch the event issues once its cancel settles is the GET the next order arrives during.
            await vi.waitFor(() => expect(qc.getQueryState(key)?.fetchStatus).toBe('fetching'), {
              interval: 1,
              timeout: 2000,
            })
          }

          held.forEach((open) => open())
          await fetchesSettled(qc)

          const final = qc.getQueryData<Order[]>(key) ?? []
          for (const p of placed) {
            expect(final.filter((o) => o.id === p.id).length, `settled: copies of ${p.id}`).toBe(1)
          }
          expect(final, 'settled: the server page').toEqual(committed)

          unsubscribe()
          qc.clear()
        },
      ),
      { numRuns: 50 },
    )
  })
})
