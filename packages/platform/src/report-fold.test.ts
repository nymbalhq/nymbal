import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { NymbalEvent, Order, OrderLineItem } from '@nymbalhq/types'
import { createEventBuilder } from './events/builder.js'
import { TEST_BUILDER_CONTEXT } from './tests/publisher.js'
import { isDecline } from './reports/definitions.js'
import { ROLLUP_EVENT_TYPES, foldEvent, recompute } from './reports/fold.js'

// What a stored figure is made of: the fold of one event is the only place an event becomes a figure, so each rule of
// the table lives here, read through `recompute` (the fold of each distinct event id once).

const ZONE = 'Europe/London'
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

interface SalesRow {
  localDay: string
  currency: string
  source: string
  capturedMinor: number
  refundedMinor: number
  paidOrders: number
}
interface FunnelRow {
  localDay: string
  source: string
  viewers: number
  cartsWithItems: number
  checkoutsStarted: number
  paymentsFailed: number
}
interface ProductRow {
  localDay: string
  variantId: string
  currency: string
  source: string
  units: number
  lineSubtotalMinor: number
}
interface Rows {
  salesHours: SalesRow[]
  funnelDays: FunnelRow[]
  productDays: ProductRow[]
  searchDays: unknown[]
  members: unknown[]
}

const dayIn = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

const noon = (day: string) => new Date(`${day}T12:00:00.000Z`)
const DAY_MS = 24 * 60 * 60 * 1000

function lineOf(variantId: string, qty: number, unit: number): OrderLineItem {
  return {
    variantId,
    productId: `product-of-${variantId}`,
    productName: 'Widget',
    variantName: 'Default',
    sku: `sku-${variantId}`,
    qty,
    unitPriceMinor: unit,
    lineSubtotalMinor: qty * unit,
    lineTaxMinor: 0,
    lineTotalMinor: qty * unit,
    imageUrl: '',
  }
}

function orderOf(overrides: Partial<Order> = {}): Order {
  return {
    id: randomUUID(),
    orderNumber: 'ORD-1',
    sequence: 1,
    customerId: null,
    status: 'processing',
    email: 'buyer@example.com',
    billingAddress: {} as Order['billingAddress'],
    shippingAddress: {} as Order['shippingAddress'],
    lineItems: [lineOf('v1', 2, 500)],
    subtotalMinor: 1000,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1000,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: 'pi_1',
    capturedMinor: 1000,
    capturedAt: null,
    refundedMinor: 0,
    captureMethod: 'provider',
    source: 'storefront',
    createdAt: '2026-01-05T12:00:00.000Z',
    updatedAt: '2026-01-05T12:00:00.000Z',
    ...overrides,
  }
}

function lookupOf(orders: Order[], carts: Record<string, string> = {}) {
  const byId = new Map(orders.map((o) => [o.id, o]))
  return {
    orderOf: (id: string) => byId.get(id) ?? null,
    cartSourceOf: (token: string) => carts[token] ?? null,
  }
}

const rowsOf = (events: NymbalEvent<unknown>[], lookup: ReturnType<typeof lookupOf>): Rows =>
  recompute(events, lookup, ZONE) as unknown as Rows

function salesOnDay(rows: Rows, day: string, currency = 'GBP') {
  const on = rows.salesHours.filter((r) => r.localDay === day && r.currency === currency)
  return {
    capturedMinor: on.reduce((s, r) => s + r.capturedMinor, 0),
    refundedMinor: on.reduce((s, r) => s + r.refundedMinor, 0),
    paidOrders: on.reduce((s, r) => s + r.paidOrders, 0),
  }
}

const event = {
  captured: (o: Order, amountMinor: number, at: Date) =>
    makeEvent(
      'payment.captured.v1',
      { paymentId: 'pi', orderId: o.id, amountMinor, currency: o.currency },
      { timestamp: at },
    ),
  refunded: (o: Order, amountMinor: number, at: Date) =>
    makeEvent(
      'payment.refunded.v1',
      { paymentId: 'pi', orderId: o.id, refundId: randomUUID(), amountMinor, currency: o.currency },
      { timestamp: at },
    ),
  paid: (o: Order, at: Date) =>
    makeEvent(
      'order.paid.v1',
      { orderId: o.id, paymentIntentId: 'pi', amountMinor: o.totalMinor, currency: o.currency },
      { timestamp: at },
    ),
  placed: (o: Order, at: Date) => makeEvent('order.placed.v1', { order: o }, { timestamp: at }),
  deleted: (o: Order, at: Date) =>
    makeEvent(
      'order.deleted.v1',
      {
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerId: o.customerId,
        createdAt: o.createdAt,
        source: o.source,
        currency: o.currency,
        capturedMinor: o.capturedMinor,
        refundedMinor: o.refundedMinor,
        lineItems: o.lineItems,
      },
      { timestamp: at },
    ),
  cartAdded: (token: string, at: Date) =>
    makeEvent('cart.item_added.v1', { cartId: token, variantId: 'v', qty: 1 }, { timestamp: at }),
  intent: (o: Order, at: Date) =>
    makeEvent('payment.intent_created.v1', { paymentId: 'pi', orderId: o.id }, { timestamp: at }),
  failed: (orderId: string, reason: string, at: Date) =>
    makeEvent('payment.failed.v1', { paymentId: 'pi', orderId, reason }, { timestamp: at }),
}

/** Each event a store makes for an order or a cart of `source`. */
function orderAndCartEvents(source: string) {
  const o = orderOf({ source: source as Order['source'] })
  const token = randomUUID()
  const at = noon('2026-02-01')
  return {
    lookup: lookupOf([o], { [token]: source }),
    events: [
      event.captured(o, 1000, at),
      event.refunded(o, 300, at),
      event.paid(o, at),
      event.placed(o, at),
      event.deleted(o, at),
      event.cartAdded(token, at),
      event.intent(o, at),
      event.failed(o.id, 'payment_failed', at),
    ],
  }
}

describe('AC-2: money stays on the day it moved', () => {
  it('AC-2: property: a capture counts on its own day and a refund on the refund’s day, days later; the order’s own day is not restated and a day’s net may be negative', () => {
    const offsetDays = fc.integer({ min: 1, max: 20 })
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 90_000 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 80 }), offsetDays), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.integer({ min: 0, max: 5 }),
        (amountMinor, refunds, captureOffset) => {
          const placedDay = noon('2026-03-01')
          const order = orderOf({ createdAt: placedDay.toISOString() })
          const capturedAt = new Date(placedDay.getTime() + captureOffset * DAY_MS)
          const refundEvents = refunds.map(([percent, days]) => {
            const at = new Date(capturedAt.getTime() + days * DAY_MS)
            return {
              at,
              amount: Math.max(1, Math.floor((amountMinor * percent) / 100)),
            }
          })
          const rows = rowsOf(
            [
              event.captured(order, amountMinor, capturedAt),
              ...refundEvents.map((r) => event.refunded(order, r.amount, r.at)),
            ],
            lookupOf([order]),
          )

          const captureDay = dayIn(capturedAt)
          expect(salesOnDay(rows, captureDay).capturedMinor).toBe(amountMinor)
          const refundDays = new Set(refundEvents.map((r) => dayIn(r.at)))
          for (const day of refundDays) {
            const expected = refundEvents
              .filter((r) => dayIn(r.at) === day)
              .reduce((s, r) => s + r.amount, 0)
            expect(salesOnDay(rows, day).refundedMinor).toBe(expected)
          }
          // A day holding only a refund nets negative, and the order's own day is not restated.
          for (const day of [...refundDays].filter((d) => d !== captureDay)) {
            const sales = salesOnDay(rows, day)
            expect(sales.capturedMinor).toBe(0)
            expect(sales.capturedMinor - sales.refundedMinor).toBe(-sales.refundedMinor)
          }
          const untouched = [dayIn(placedDay)].filter(
            (d) => d !== captureDay && !refundDays.has(d),
          )
          for (const day of untouched) {
            expect(salesOnDay(rows, day)).toEqual({
              capturedMinor: 0,
              refundedMinor: 0,
              paidOrders: 0,
            })
          }
        },
      ),
    )
  })
})

describe('AC-3: an imported order counts on its own date', () => {
  it('AC-3: an import counts once on order.createdAt, under import, with its captured and refunded amounts and one paid order; a repeat of the event, and the day the import ran, add nothing', () => {
    const order = orderOf({
      source: 'import',
      createdAt: '2026-02-03T09:00:00.000Z',
      capturedMinor: 5000,
      refundedMinor: 1000,
    })
    const importRun = noon('2026-04-01')
    const placed = event.placed(order, importRun)

    const rows = rowsOf([placed, placed], lookupOf([order]))

    expect(salesOnDay(rows, '2026-02-03')).toEqual({
      capturedMinor: 5000,
      refundedMinor: 1000,
      paidOrders: 1,
    })
    expect(rows.salesHours.filter((r) => r.localDay === dayIn(importRun))).toHaveLength(0)
    expect([...new Set(rows.salesHours.map((r) => r.source))]).toEqual(['import'])
  })

  it('AC-3: an order placed at the storefront folds nothing from order.placed; an import that captured nothing adds no paid order', () => {
    const placedAtTill = orderOf({ source: 'storefront' })
    const uncaptured = orderOf({
      source: 'import',
      createdAt: '2026-02-04T09:00:00.000Z',
      capturedMinor: 0,
      refundedMinor: 0,
    })

    const atTill = rowsOf([event.placed(placedAtTill, noon('2026-02-05'))], lookupOf([placedAtTill]))
    const imported = rowsOf([event.placed(uncaptured, noon('2026-04-01'))], lookupOf([uncaptured]))

    expect(atTill.salesHours).toHaveLength(0)
    expect(salesOnDay(imported, '2026-02-04').paidOrders).toBe(0)
    expect(imported.productDays).toHaveLength(0)
  })
})

describe('AC-4: a synthetic order or cart leaves no trace', () => {
  it('AC-4: property: every event of a synthetic order or cart folds to no delta, while the same event of an import or a storefront order does', () => {
    const synthetic = orderAndCartEvents('synthetic')
    const real = (i: number) =>
      orderAndCartEvents(i === 3 || i === 4 ? 'import' : 'storefront')

    fc.assert(
      fc.property(fc.integer({ min: 0, max: synthetic.events.length - 1 }), (i) => {
        expect(foldEvent(synthetic.events[i]!, synthetic.lookup, ZONE)).toEqual([])
        const control = real(i)
        expect(foldEvent(control.events[i]!, control.lookup, ZONE).length).toBeGreaterThan(0)
      }),
      { numRuns: 50 },
    )
  })

  it('AC-4: synthetic orders and carts appear nowhere in what a recompute produces, beside real ones that do', () => {
    const synthetic = orderAndCartEvents('synthetic')
    const real = orderAndCartEvents('storefront')
    const rows = rowsOf([...synthetic.events, ...real.events], {
      orderOf: (id) => synthetic.lookup.orderOf(id) ?? real.lookup.orderOf(id),
      cartSourceOf: (token) => synthetic.lookup.cartSourceOf(token) ?? real.lookup.cartSourceOf(token),
    })

    expect(JSON.stringify(rows)).not.toContain('synthetic')
    expect(rows.salesHours.length).toBeGreaterThan(0)
  })
})

describe('AC-5: the funnel counts carts and checkouts once a day, and only real declines', () => {
  it('AC-5: a cart counts once a day on item_added and again on another day, and cart.created is no event of the rollup', () => {
    const token = randomUUID()
    const lookup = lookupOf([], { [token]: 'storefront' })
    const rows = rowsOf(
      [
        event.cartAdded(token, noon('2026-02-10')),
        event.cartAdded(token, noon('2026-02-10')),
        event.cartAdded(token, noon('2026-02-11')),
      ],
      lookup,
    )

    const carts = Object.fromEntries(rows.funnelDays.map((r) => [r.localDay, r.cartsWithItems]))
    expect(carts).toEqual({ '2026-02-10': 1, '2026-02-11': 1 })
    expect(ROLLUP_EVENT_TYPES).not.toContain('cart.created.v1')
    expect(
      foldEvent(makeEvent('cart.created.v1', { cartId: token, token }), lookup, ZONE),
    ).toEqual([])
  })

  it('AC-5: a retried payment intent counts one checkout that day, and one more on another day', () => {
    const o = orderOf()
    const rows = rowsOf(
      [
        event.intent(o, noon('2026-02-12')),
        event.intent(o, noon('2026-02-12')),
        event.intent(o, noon('2026-02-13')),
      ],
      lookupOf([o]),
    )

    const started = Object.fromEntries(rows.funnelDays.map((r) => [r.localDay, r.checkoutsStarted]))
    expect(started).toEqual({ '2026-02-12': 1, '2026-02-13': 1 })
  })

  const DECLINES = ['payment_failed', 'payment_requires_action', 'Your card was declined.', 'card_declined']
  const NOT_DECLINES = [
    'no_order',
    'order_cancelled_refunded',
    'order_not_pending: shipped',
    'duplicate_capture_refunded',
    'duplicate_capture_refund_failed',
    'amount_mismatch',
    'stock_unavailable: 019a-variant',
    'malformed_capture',
  ]

  it('AC-5: isDecline holds for a provider’s or checkout’s decline and for none of the reasons a captured payment fails to confirm', () => {
    expect(DECLINES.map((r) => isDecline(r))).toEqual(DECLINES.map(() => true))
    expect(NOT_DECLINES.map((r) => isDecline(r))).toEqual(NOT_DECLINES.map(() => false))
  })

  it('AC-5: property: paymentsFailed equals the real declines of known orders, whatever else fails beside them', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            reason: fc.constantFrom(...DECLINES, ...NOT_DECLINES),
            orderId: fc.constantFrom('known', '', 'unknown-order-id'),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (failures) => {
          const o = orderOf()
          const events = failures.map((f) =>
            event.failed(f.orderId === 'known' ? o.id : f.orderId, f.reason, noon('2026-02-14')),
          )
          const rows = rowsOf(events, lookupOf([o]))

          const expected = failures.filter(
            (f) => f.orderId === 'known' && DECLINES.includes(f.reason),
          ).length
          expect(rows.funnelDays.reduce((s, r) => s + r.paymentsFailed, 0)).toBe(expected)
        },
      ),
    )
  })
})

describe('AC-7: paid lines add up by variant, currency and source', () => {
  it('AC-7: lines count on the day the order was paid, never when it was placed, and each order’s lines add to its variant, currency and source', () => {
    const paidDay = noon('2026-02-20')
    const first = orderOf({
      createdAt: '2026-02-01T12:00:00.000Z',
      lineItems: [lineOf('v1', 2, 500), lineOf('v2', 1, 300)],
    })
    const second = orderOf({
      createdAt: '2026-02-02T12:00:00.000Z',
      lineItems: [lineOf('v1', 3, 500)],
    })
    const euro = orderOf({ currency: 'EUR', lineItems: [lineOf('v1', 1, 900)] })
    const fromAgent = orderOf({ source: 'agent:scout', lineItems: [lineOf('v1', 4, 500)] })

    const rows = rowsOf(
      [
        event.paid(first, paidDay),
        event.paid(second, paidDay),
        event.paid(euro, paidDay),
        event.paid(fromAgent, paidDay),
      ],
      lookupOf([first, second, euro, fromAgent]),
    )

    const key = (r: ProductRow) => `${r.localDay} ${r.variantId} ${r.currency} ${r.source}`
    const seen = new Map(rows.productDays.map((r) => [key(r), r]))
    expect(seen.get('2026-02-20 v1 GBP storefront')).toMatchObject({
      units: 5,
      lineSubtotalMinor: 2500,
    })
    expect(seen.get('2026-02-20 v2 GBP storefront')).toMatchObject({
      units: 1,
      lineSubtotalMinor: 300,
    })
    expect(seen.get('2026-02-20 v1 EUR storefront')).toMatchObject({
      units: 1,
      lineSubtotalMinor: 900,
    })
    expect(seen.get('2026-02-20 v1 GBP agent:scout')).toMatchObject({
      units: 4,
      lineSubtotalMinor: 2000,
    })
    expect(rows.productDays.filter((r) => r.localDay !== '2026-02-20')).toHaveLength(0)
  })

  it('AC-7: property: units and subtotals of every paid line reach the rollup, each order once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 5000 })), {
            minLength: 1,
            maxLength: 4,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (orders) => {
          const built = orders.map((lines) =>
            orderOf({ lineItems: lines.map(([qty, unit], i) => lineOf(`variant-${i}`, qty, unit)) }),
          )
          const rows = rowsOf(
            built.map((o) => event.paid(o, noon('2026-02-21'))),
            lookupOf(built),
          )

          const lines = built.flatMap((o) => o.lineItems)
          expect(rows.productDays.reduce((s, r) => s + r.units, 0)).toBe(
            lines.reduce((s, l) => s + l.qty, 0),
          )
          expect(rows.productDays.reduce((s, r) => s + r.lineSubtotalMinor, 0)).toBe(
            lines.reduce((s, l) => s + l.lineSubtotalMinor, 0),
          )
        },
      ),
    )
  })
})
