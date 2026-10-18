import fc from 'fast-check'
import { QueryClient, hashKey } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
// Shared shapes, read from source: the admin's dependency on @nymbalhq/types is part of P1-08 itself.
import type { Order, OrderStatus } from '../../../../packages/types/src/index'
import { useNotifications } from '@/hooks/useNotifications'
import { createEventHandlers } from './handlers'

// P1-08 AC-3 and AC-4: what the realtime handler does with real event payloads
// (packages/types/src/events/payloads.ts). AC-3 kills: a placed order prepended to every list and page, whatever its
// filter; a `{ orderId }` payload merged into a cached order. AC-4 kills: notifications built from fields the payload
// does not carry (`row.productName`, `row.stock`, `payload.adapter`), which render `undefined`.

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

/** The spec's admit predicate (AC-3). */
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

describe('P1-08 AC-3: a placed order goes only into the lists whose filter admits it', () => {
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
        (h, orderId) => h('order.refunded.v1', { orderId, amountMinor: 1000, reason: 'returned' }),
      ],
      [
        'order.partially_refunded.v1',
        (h, orderId) =>
          h('order.partially_refunded.v1', {
            orderId,
            amountMinor: 500,
            lineItems: [],
            reason: 'one item',
          }),
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

describe('P1-08 AC-4: notifications name what the payload carries', () => {
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
