import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  EVT_ORDER_DELIVERED,
  EVT_ORDER_SHIPPED,
  ORDER_KEY_HEADER,
  type OrderLineItem,
  type OrderStatus,
  type ShippingAdapter,
} from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { postDelivery, recordsFor, type Delivered } from '../inbound-webhooks.js'
import { address, checkoutOf, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { eventRows, maxSeq, type EventRow } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import type { ShopResponse } from '../shopper.js'
import {
  createTestShipAdapter,
  shipDelivery,
  TEST_SHIP,
  TRACKING,
  TRACKING_STATUSES,
  update,
  type CarrierUpdate,
  type SignedDelivery,
  type TrackingStatus,
} from '../test-ship.js'

// Tracking updates from the store's shipping provider (`test-ship`, a custom shipping adapter) on one dialect, through
// the served kernel's real routes: what the admin's ship action records, what a delivered update moves, what every
// other update leaves alone, what is refused whole, and that a replayed or racing delivery moves an order once. Rows
// and events are read through a second connection.

export interface OpenShippingTrackingKernel {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: { adapters: { shipping: ShippingAdapter } }
}

export interface ShippingTrackingSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(opts: OpenShippingTrackingKernel): Promise<Kernel>
  propertyRuns: number
}

const HANDLER = `webhook:${TEST_SHIP}`
const TRACKING_ACTOR = 'system:shipping-tracking'
const INVALID_TRANSITION = 'status.invalid_transition'
const NOT_DELIVERED: TrackingStatus[] = TRACKING_STATUSES.filter((s) => s !== 'delivered')

function storeConfig(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: { ...config.commerce, shipping: { provider: 'custom' } },
  } as NymbalConfig
}

const freshId = (): string => `dlv_${randomUUID()}`
/** A tracking number in its normalised form: no whitespace, upper case. */
const freshNumber = (): string => `1Z${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`
const canon = (value: string): string => value.replace(/\s+/g, '').toUpperCase()

/** A tracking number as a merchant or a carrier may write it: grouped by spaces or a tab, padded, in either case. */
type Spelling = { lower: boolean; every: number; tab: boolean; left: number; right: number }
const arbSpelling: fc.Arbitrary<Spelling> = fc.record({
  lower: fc.boolean(),
  every: fc.integer({ min: 1, max: 5 }),
  tab: fc.boolean(),
  left: fc.integer({ min: 0, max: 2 }),
  right: fc.integer({ min: 0, max: 2 }),
})
function spell(n: string, s: Spelling): string {
  const groups = n.match(new RegExp(`.{1,${s.every}}`, 'g')) ?? [n]
  const body = groups.join(s.tab ? '\t' : ' ')
  return `${' '.repeat(s.left)}${s.lower ? body.toLowerCase() : body}${' '.repeat(s.right)}`
}
/** A spelling that differs from the number as shipped, so only normalisation can match the two. */
const otherSpelling = (n: string, s: Spelling): string => {
  const spelt = spell(n, s)
  return spelt === n ? ` ${n.toLowerCase()} ` : spelt
}

const arbCarrier: fc.Arbitrary<string | null> = fc.constantFrom('UPS', 'ups', 'royal-mail', null)

function line(totalMinor: number): OrderLineItem {
  return {
    variantId: randomUUID(),
    productId: randomUUID(),
    productName: 'Tracked Widget',
    variantName: 'Default',
    sku: 'TRACKED-1',
    qty: 1,
    unitPriceMinor: totalMinor,
    lineSubtotalMinor: totalMinor,
    lineTaxMinor: 0,
    lineTotalMinor: totalMinor,
    imageUrl: '',
  }
}

interface HistoryRow {
  from_status: string | null
  to_status: string
  actor: string
  note: string
}

interface ShipmentRow {
  order_id: string
  carrier: string
  tracking_number: string
}

function tally(answers: Delivered[]) {
  return {
    received: answers.filter((a) => a.status === 200 && a.data?.received === true).length,
    deduped: answers.filter((a) => a.status === 200 && a.data?.deduped === true).length,
  }
}

/** The actor of a history row, an admin's id left out. */
const actorKind = (actor: string): string => (actor.startsWith('admin:') ? 'admin' : actor)

export function shippingTrackingSuite(
  dialect: Kernel['dialect'],
  options: ShippingTrackingSuiteOptions,
) {
  describe(`shipping tracking webhooks (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient
    let base = ''
    let stock: Seeded
    /** The order id of every review the store asked for, in order. */
    const reviewRequests: string[] = []

    beforeAll(async () => {
      k = await options.open({
        configure: storeConfig,
        appOptions: { adapters: { shipping: createTestShipAdapter() } },
      })
      const reviews = k.app.adapters.reviews
      const requestReview = reviews.requestReview.bind(reviews)
      reviews.requestReview = async (orderId) => {
        reviewRequests.push(orderId)
        return requestReview(orderId)
      }
      served = await serveKernel(k)
      base = served.baseUrl
      admin = await adminClient(k, base)
      raw = openRaw(k.dialect, k.target)
      stock = await seedVariant(k, 10_000)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    // ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────

    const send = (delivery: SignedDelivery): Promise<Delivered> =>
      postDelivery(base, TEST_SHIP, delivery)

    const ship = (orderId: string, trackingNumber: string, carrier: string) =>
      admin.call<unknown>('POST', `/api/admin/orders/${orderId}/ship`, { trackingNumber, carrier })

    const markDelivered = (orderId: string) =>
      admin.call<unknown>('POST', `/api/admin/orders/${orderId}/mark-delivered`, {})

    const answerOf = (res: ShopResponse<unknown>) => [res.status, res.body.error?.code ?? null]

    /** Every event appended has been handed to the bus (or given up on), so every handler run that will happen has. */
    async function delivered(): Promise<void> {
      await vi.waitFor(
        async () => {
          const open = (await eventRows(raw)).filter(
            (r) => r.deliveredAt == null && r.deadAt == null,
          )
          expect(open.map((r) => r.type)).toEqual([])
        },
        { timeout: 10_000, interval: 20 },
      )
    }

    /** Events since `afterSeq` that were retried or given up on: [type, attempts, dead]. */
    async function retriedSince(afterSeq: number): Promise<unknown[]> {
      return (await eventRows(raw, 'seq > ?', [afterSeq]))
        .filter((r) => r.attempts > 0 || r.deadAt != null)
        .map((r) => [r.type, r.attempts, r.deadAt != null])
    }

    /** The order's events of `type`, in seq order. */
    async function orderEvents(orderId: string, type: string): Promise<EventRow[]> {
      return (await eventRows(raw, 'type = ?', [type])).filter(
        (r) => (r.envelope.payload as { orderId?: unknown }).orderId === orderId,
      )
    }

    async function historyTo(orderId: string, toStatus: OrderStatus): Promise<HistoryRow[]> {
      return raw.rows<HistoryRow>(
        'SELECT from_status, to_status, actor, note FROM order_history WHERE order_id = ? AND to_status = ?',
        [orderId, toStatus],
      )
    }

    async function shipmentsOf(orderId: string): Promise<ShipmentRow[]> {
      return raw.rows<ShipmentRow>(
        'SELECT order_id, carrier, tracking_number FROM order_shipments WHERE order_id = ?',
        [orderId],
      )
    }

    async function statusOf(orderId: string): Promise<string> {
      return (
        await raw.one<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId])
      ).status
    }

    /** Every order in the store: [id, status, its history rows]. */
    async function everyOrder(): Promise<Array<[string, string, number]>> {
      const rows = await raw.rows<{ id: string; status: string; n: number | string }>(
        'SELECT o.id, o.status, (SELECT count(*) FROM order_history h WHERE h.order_id = o.id) AS n FROM orders o ORDER BY o.id',
      )
      return rows.map((r) => [r.id, r.status, Number(r.n)])
    }

    /** An order written at `status` through the importer, paid unless pending; refunded in whole or part as named. */
    async function seedOrder(status: OrderStatus): Promise<{ id: string; orderNumber: string }> {
      const id = randomUUID()
      const orderNumber = `TRK-${randomUUID().slice(0, 8)}`
      const total = 2500
      const refundedMinor =
        status === 'refunded' ? total : status === 'partially_refunded' ? 1000 : 0
      await k.services.order.importOrder({
        orderId: id,
        orderNumber,
        status,
        customerId: null,
        email: `buyer-${randomUUID()}@tracking.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [line(total)],
        subtotalMinor: total,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: total,
        currency: 'GBP',
        createdAt: new Date(),
        ...(status !== 'pending' && {
          capturedMinor: total,
          captureMethod: 'import' as const,
          refundedMinor,
        }),
      })
      return { id, orderNumber }
    }

    /** A processing order shipped by the admin with `trackingNumber` as the merchant typed it. */
    async function shippedOrder(trackingNumber: string, carrier = 'Royal Mail') {
      const order = await seedOrder('processing')
      const res = await ship(order.id, trackingNumber, carrier)
      expect(answerOf(res), JSON.stringify(res.body)).toEqual([200, null])
      await delivered()
      return order
    }

    /** A shipment row written through the repository, for an order the ship action never recorded. */
    async function recordShipment(orderId: string, trackingNumber: string): Promise<void> {
      await k.store.transaction((tx) =>
        k.repos.orderShipment.record(tx, {
          orderId,
          carrier: 'UPS',
          trackingNumber,
          at: new Date(),
        }),
      )
    }

    /** Postgres backends of this database waiting on a lock. */
    async function lockWaiters(): Promise<number> {
      const [row] = await raw.rows<{ n: number | string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      return Number(row?.n ?? 0)
    }

    /**
     * Holds the first status write of `orderId` to `toStatus` inside its transaction, after the command's read, until
     * `releaseWhenOvertaken`: so a second command of the same move always overlaps it. The write is the repository's
     * `setStatus` or `setStatusIf`, the wrap of the order service's own conditional-write test.
     */
    function holdFirstWrite(orderId: string, toStatus: OrderStatus) {
      const repo = k.repos.order
      const { setStatus, setStatusIf } = repo
      let held = false
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const hold = async (id: string, status: OrderStatus) => {
        if (held || id !== orderId || status !== toStatus) return
        held = true
        await gate
      }
      repo.setStatus = async (...args: Parameters<typeof setStatus>) => {
        await hold(args[1], args[2])
        return setStatus.apply(repo, args)
      }
      repo.setStatusIf = async (...args: Parameters<typeof setStatusIf>) => {
        await hold(args[1], args[3])
        return setStatusIf.apply(repo, args)
      }
      return {
        /**
         * Lets the held write go once another command has committed the same move (unlocked), waits on the held
         * command's row lock (locked), or nothing else is left to run but the held command.
         */
        async releaseWhenOvertaken(nothingElseLeft: () => Promise<boolean>) {
          await vi.waitFor(
            async () => {
              expect(held, 'no write was held').toBe(true)
              const overtaken =
                (await statusOf(orderId)) === toStatus ||
                (await lockWaiters()) > 0 ||
                (await nothingElseLeft())
              expect(overtaken, 'nothing overlapped the held write').toBe(true)
            },
            { timeout: 15_000, interval: 20 },
          )
          release()
        },
        restore() {
          repo.setStatus = setStatus
          repo.setStatusIf = setStatusIf
          release()
        },
      }
    }

    // ─── AC-1: the ship action records the shipment ──────────────────────────────────────────────────────────

    it(`AC-1: shipping with ' 1z 999 ' and UPS keeps the history note and order.shipped payload as given and leaves one order_shipments row, tracking_number 1Z999; a ship refused by its transition leaves no row; a second ship answers 409 ${INVALID_TRANSITION} and leaves one row, one shipped history row and one order.shipped (${dialect})`, async () => {
      const order = await seedOrder('processing')
      const trackingNumber = ' 1z 999 '
      const carrier = 'UPS'

      const first = await ship(order.id, trackingNumber, carrier)

      expect(answerOf(first), JSON.stringify(first.body)).toEqual([200, null])
      expect((await historyTo(order.id, 'shipped')).map((r) => r.note)).toEqual([
        `Shipped via ${carrier}: ${trackingNumber}`,
      ])
      expect(
        (await orderEvents(order.id, EVT_ORDER_SHIPPED)).map((e) => e.envelope.payload),
      ).toEqual([{ orderId: order.id, trackingNumber, carrier }])
      const rows = await shipmentsOf(order.id)
      expect(rows).toEqual([{ order_id: order.id, carrier, tracking_number: '1Z999' }])

      const unshippable = await seedOrder('confirmed')
      const refused = await ship(unshippable.id, freshNumber(), carrier)
      expect(answerOf(refused)).toEqual([409, INVALID_TRANSITION])
      expect(await shipmentsOf(unshippable.id)).toEqual([])

      const again = await ship(order.id, freshNumber(), 'DHL')
      expect(answerOf(again)).toEqual([409, INVALID_TRANSITION])
      expect(await shipmentsOf(order.id)).toEqual(rows)
      expect((await historyTo(order.id, 'shipped')).length).toBe(1)
      expect((await orderEvents(order.id, EVT_ORDER_SHIPPED)).length).toBe(1)
    })

    it(`AC-1: a ship whose history append throws after the status write leaves the order processing, no order_shipments row and no order.shipped (${dialect})`, async () => {
      const order = await seedOrder('processing')
      const history = k.repos.orderHistory
      const append = history.append
      history.append = async (...args: Parameters<typeof append>) => {
        const [, entry] = args
        if (entry.orderId === order.id && entry.toStatus === 'shipped') {
          throw new Error('the history append fails')
        }
        return append.apply(history, args)
      }
      let res: ShopResponse<unknown>
      try {
        res = await ship(order.id, freshNumber(), 'UPS')
      } finally {
        history.append = append
      }
      await delivered()

      expect(res.status).toBe(500)
      expect(await statusOf(order.id)).toBe('processing')
      expect(await shipmentsOf(order.id)).toEqual([])
      expect(await orderEvents(order.id, EVT_ORDER_SHIPPED)).toEqual([])
      expect(await historyTo(order.id, 'shipped')).toEqual([])
    })

    if (dialect === 'postgres') {
      it(`AC-1: two overlapping ships of one order, the first held between its read and its write, answer one 200 and one 409 ${INVALID_TRANSITION}, and leave one order_shipments row, one shipped history row and one order.shipped (${dialect})`, async () => {
        const order = await seedOrder('processing')
        const trackingNumber = freshNumber()
        const hold = holdFirstWrite(order.id, 'shipped')
        let answers: Array<ShopResponse<unknown>>
        try {
          let settled = 0
          const both = Promise.all(
            [0, 1].map(async () => {
              const res = await ship(order.id, trackingNumber, 'UPS')
              settled += 1
              return res
            }),
          )
          await hold.releaseWhenOvertaken(async () => settled === 1)
          answers = await both
        } finally {
          hold.restore()
        }
        await delivered()

        expect(answers.map(answerOf).sort()).toEqual([
          [200, null],
          [409, INVALID_TRANSITION],
        ])
        expect((await shipmentsOf(order.id)).map((r) => r.tracking_number)).toEqual([
          trackingNumber,
        ])
        expect((await historyTo(order.id, 'shipped')).length).toBe(1)
        expect((await orderEvents(order.id, EVT_ORDER_SHIPPED)).length).toBe(1)
      }, 60_000)
    }

    // ─── AC-2: a delivered update delivers the order ─────────────────────────────────────────────────────────

    it(`AC-2: property: a checkout order shipped with N under one carrier, sent a signed delivered update for N in another spacing and case under another carrier code, answers 200 { received: true, events: 1 } and is then delivered: the order read gives delivered with a timeline ending delivered, the admin history has one order.delivered, and the delivered history row's actor is ${TRACKING_ACTOR} (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbSpelling, arbSpelling, arbCarrier, async (shipped, sent, carrier) => {
          const n = freshNumber()
          const placed = await checkoutOf(k, stock, 1, `buyer-${randomUUID()}@tracking.test`)
          const process = await admin.call(
            'POST',
            `/api/admin/orders/${placed.orderId}/process`,
            {},
          )
          expect(answerOf(process), JSON.stringify(process.body)).toEqual([200, null])
          const shipping = await ship(placed.orderId, spell(n, shipped), 'Royal Mail')
          expect(answerOf(shipping), JSON.stringify(shipping.body)).toEqual([200, null])

          const answer = await send(
            shipDelivery({
              id: freshId(),
              updates: [update(otherSpelling(n, sent), 'delivered', { carrier })],
            }),
          )
          await delivered()

          expect([answer.status, answer.data], JSON.stringify(answer.body)).toEqual([
            200,
            { received: true, events: 1 },
          ])
          const historyRows = await raw.count('order_history', 'order_id = ?', [placed.orderId])
          await vi.waitFor(
            async () => {
              const stored = await k.documentStore.get<{ history: unknown[] }>(
                'orders',
                placed.orderNumber,
              )
              expect(stored?.history.length).toBe(historyRows)
            },
            { timeout: 10_000, interval: 20 },
          )
          const read = await fetch(
            new URL(`/api/orders/${encodeURIComponent(placed.orderNumber)}`, base),
            { headers: { [ORDER_KEY_HEADER]: placed.orderKey } },
          )
          const body = (await read.json()) as {
            data?: { status: string; timeline?: Array<{ kind: string }> }
          }
          expect([body.data?.status, body.data?.timeline?.at(-1)?.kind]).toEqual([
            'delivered',
            'delivered',
          ])
          const page = await admin.call<{ entries: Array<{ type: string }> }>(
            'GET',
            `/api/admin/orders/${placed.orderId}/history`,
          )
          expect(page.body.data?.entries.filter((e) => e.type === EVT_ORDER_DELIVERED).length).toBe(
            1,
          )
          expect((await historyTo(placed.orderId, 'delivered')).map((r) => r.actor)).toEqual([
            TRACKING_ACTOR,
          ])
        }),
        { numRuns: Math.min(options.propertyRuns, 6) },
      )
    }, 120_000)

    // ─── AC-3: every other update changes nothing ────────────────────────────────────────────────────────────

    it(`AC-3: property: updates for a shipped order's N with any status but delivered, and delivered updates for an unknown number, for a processing, delivered, refunded or partially refunded order holding a shipment row, or for an order shipped before its row existed, each answer 200, leave every order's status and history unchanged, and no event is retried (${dialect})`, async () => {
      const numbers = {
        shipped: freshNumber(),
        processing: freshNumber(),
        delivered: freshNumber(),
        refunded: freshNumber(),
        partially_refunded: freshNumber(),
        preUpgrade: freshNumber(),
      }
      await shippedOrder(numbers.shipped)
      for (const status of ['processing', 'delivered', 'refunded', 'partially_refunded'] as const) {
        const seeded = await seedOrder(status)
        await recordShipment(seeded.id, numbers[status])
      }
      // Shipped before the upgrade: the order is shipped, and nothing records its number.
      await seedOrder('shipped')
      await delivered()

      type Target = keyof typeof numbers | 'unknown'
      const arbUpdate: fc.Arbitrary<CarrierUpdate> = fc
        .record({
          target: fc.constantFrom<Target>(
            'shipped',
            'processing',
            'delivered',
            'refunded',
            'partially_refunded',
            'preUpgrade',
            'unknown',
          ),
          status: fc.constantFrom(...TRACKING_STATUSES),
          other: fc.constantFrom(...NOT_DELIVERED),
          spelling: arbSpelling,
          carrier: arbCarrier,
        })
        .map(({ target, status, other, spelling, carrier }) => {
          const n = target === 'unknown' ? freshNumber() : numbers[target]
          // The shipped order is only ever sent what must not move it.
          return update(spell(n, spelling), target === 'shipped' ? other : status, { carrier })
        })

      await fc.assert(
        fc.asyncProperty(fc.array(arbUpdate, { minLength: 1, maxLength: 3 }), async (updates) => {
          const before = await everyOrder()
          const start = await maxSeq(raw)

          const answer = await send(shipDelivery({ id: freshId(), updates }))
          await delivered()

          const seen = JSON.stringify(updates)
          expect([answer.status, answer.data], `${seen} → ${JSON.stringify(answer.body)}`).toEqual([
            200,
            { received: true, events: updates.length },
          ])
          expect(await everyOrder(), seen).toEqual(before)
          expect(await retriedSince(start), seen).toEqual([])
        }),
        { numRuns: options.propertyRuns * 2 },
      )
    }, 180_000)

    // ─── AC-4: refused whole ─────────────────────────────────────────────────────────────────────────────────

    const validUpdate: fc.Arbitrary<CarrierUpdate> = fc
      .record({ status: fc.constantFrom(...TRACKING_STATUSES), carrier: arbCarrier })
      .map(({ status, carrier }) => update(freshNumber(), status, { carrier }))

    const unreadableDate = fc
      .constantFrom('not a date', '', 'yesterday', '2026-13-45T99:99:99Z', 'Z')
      .filter((s) => Number.isNaN(Date.parse(s)))

    const sample = (): CarrierUpdate => update(freshNumber(), 'delivered')

    /** One way to break the tracking rule. */
    const BREAKS: Record<string, fc.Arbitrary<CarrierUpdate>> = {
      'no tracking number': fc.constant(null).map(() => {
        const { tracking_number: _n, ...rest } = sample()
        return rest
      }),
      'a non-string tracking number': fc
        .oneof(fc.integer(), fc.constant(null), fc.constant({}), fc.boolean())
        .map((tracking_number) => ({ ...sample(), tracking_number })),
      'an empty or whitespace-only tracking number': fc
        .constantFrom('', ' ', '  ', '\t', ' \n ')
        .map((tracking_number) => ({ ...sample(), tracking_number })),
      'a non-string, non-null carrier': fc
        .oneof(fc.integer(), fc.boolean(), fc.constant({}), fc.array(fc.string(), { maxLength: 2 }))
        .map((carrier) => ({ ...sample(), carrier })),
      'a status outside the seven': fc
        .constantFrom('Delivered', 'DELIVERED', 'lost', '', 'in-transit', 'attempted', 7)
        .map((status) => ({ ...sample(), status })),
      'an unreadable occurredAt': unreadableDate.map((occurred_at) => ({
        ...sample(),
        occurred_at,
      })),
    }

    it(`AC-4: property: a delivery holding an update that breaks the tracking rule (no tracking number, a non-string one, an empty or whitespace-only one, a non-string non-null carrier, a status outside the seven, an unreadable occurredAt), after valid updates or alone, answers 500 webhook.event_invalid and leaves the events, processed_events and order_shipments counts unchanged; the same delivery fixed and re-signed under its id is then received (${dialect})`, async () => {
      const counts = async () => ({
        events: await raw.count('events'),
        records: await raw.count('processed_events'),
        shipments: await raw.count('order_shipments'),
      })
      for (const [kind, broken] of Object.entries(BREAKS)) {
        await fc.assert(
          fc.asyncProperty(fc.array(validUpdate, { maxLength: 2 }), broken, async (head, bad) => {
            const id = freshId()
            const before = await counts()

            const answer = await send(shipDelivery({ id, updates: [...head, bad] }))

            const seen = `${kind}: ${JSON.stringify(bad)} → ${answer.status} ${JSON.stringify(answer.body)}`
            expect([answer.status, answer.error?.code], seen).toEqual([
              500,
              'webhook.event_invalid',
            ])
            expect(await counts(), seen).toEqual(before)

            const retry = await send(shipDelivery({ id, updates: [...head, sample()] }))
            expect([retry.status, retry.data], seen).toEqual([
              200,
              { received: true, events: head.length + 1 },
            ])
            expect(await recordsFor(raw, HANDLER, id)).toBe(1)
            await delivered()
          }),
          { numRuns: 2 },
        )
      }
    }, 120_000)

    // ─── AC-5: a replayed update moves the order once ────────────────────────────────────────────────────────

    for (const concurrent of dialect === 'postgres' ? [false, true] : [false]) {
      const how = concurrent ? 'all at once' : 'one after another'

      it(`AC-5: property: one signed delivered delivery for a shipped order's N sent k times (2-5), ${how}, leaves one processed_events row and one ${TRACKING}; the order is delivered once by the tracking handler, with one order.delivered and one review request, and no event is retried (${dialect})`, async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 5 }), arbSpelling, async (times, spelling) => {
            const n = freshNumber()
            const order = await shippedOrder(n)
            const id = freshId()
            const delivery = shipDelivery({
              id,
              updates: [update(otherSpelling(n, spelling), 'delivered')],
            })
            const seq = await maxSeq(raw)
            const reviewsBefore = reviewRequests.filter((o) => o === order.id).length

            const answers = concurrent
              ? await Promise.all(Array.from({ length: times }, () => send(delivery)))
              : await (async () => {
                  const out: Delivered[] = []
                  for (let i = 0; i < times; i += 1) out.push(await send(delivery))
                  return out
                })()
            await delivered()

            const seen = answers.map((a) => `${a.status} ${JSON.stringify(a.body)}`).join('\n')
            expect(tally(answers), seen).toEqual({ received: 1, deduped: times - 1 })
            expect(await recordsFor(raw, HANDLER, id)).toBe(1)
            expect((await eventRows(raw, 'seq > ? AND type = ?', [seq, TRACKING])).length).toBe(1)
            expect((await historyTo(order.id, 'delivered')).map((r) => r.actor)).toEqual([
              TRACKING_ACTOR,
            ])
            expect((await orderEvents(order.id, EVT_ORDER_DELIVERED)).length).toBe(1)
            expect(reviewRequests.filter((o) => o === order.id).length).toBe(reviewsBefore + 1)
            expect(await retriedSince(seq)).toEqual([])
          }),
          { numRuns: 4 },
        )
      }, 120_000)
    }

    it(`AC-5: property: k distinct delivered deliveries for a shipped order's N (2-5) and one admin mark-delivered at a generated place among them, one after another, give one delivered history row, by whichever came first, one order.delivered and one review request; the admin call answers 409 ${INVALID_TRANSITION} unless it came first, and no event is retried (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .integer({ min: 2, max: 5 })
            .chain((count) =>
              fc.tuple(fc.constant(count), fc.integer({ min: 0, max: count }), arbSpelling),
            ),
          async ([times, adminAt, spelling]) => {
            const n = freshNumber()
            const order = await shippedOrder(n)
            const seq = await maxSeq(raw)
            const reviewsBefore = reviewRequests.filter((o) => o === order.id).length
            let adminAnswer: unknown[] = []

            for (let i = 0; i <= times; i += 1) {
              if (i === adminAt) {
                adminAnswer = answerOf(await markDelivered(order.id))
              } else {
                const answer = await send(
                  shipDelivery({
                    id: freshId(),
                    updates: [update(otherSpelling(n, spelling), 'delivered')],
                  }),
                )
                expect(answer.data, JSON.stringify(answer.body)).toEqual({
                  received: true,
                  events: 1,
                })
              }
              await delivered()
            }

            const first = adminAt === 0 ? 'admin' : TRACKING_ACTOR
            expect((await historyTo(order.id, 'delivered')).map((r) => actorKind(r.actor))).toEqual(
              [first],
            )
            expect(adminAnswer).toEqual(adminAt === 0 ? [200, null] : [409, INVALID_TRANSITION])
            expect((await orderEvents(order.id, EVT_ORDER_DELIVERED)).length).toBe(1)
            expect(reviewRequests.filter((o) => o === order.id).length).toBe(reviewsBefore + 1)
            expect(await retriedSince(seq)).toEqual([])
          },
        ),
        {
          numRuns: options.propertyRuns,
          examples: [[[2, 1, { lower: true, every: 3, tab: false, left: 1, right: 0 }]]],
        },
      )
    }, 180_000)

    if (dialect === 'postgres') {
      it(`AC-5: property: k distinct delivered deliveries for a shipped order's N (2-4) and one or two admin mark-delivered calls, all at once, with the first delivered write held between its read and its write, give one delivered history row, one order.delivered and one review request; every admin call but the one that moved the order answers 409 ${INVALID_TRANSITION}, and no event is retried (${dialect})`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 4 }),
            fc.integer({ min: 1, max: 2 }),
            async (times, admins) => {
              const n = freshNumber()
              const order = await shippedOrder(n)
              const seq = await maxSeq(raw)
              const reviewsBefore = reviewRequests.filter((o) => o === order.id).length
              const hold = holdFirstWrite(order.id, 'delivered')
              let deliveries: Delivered[]
              let adminAnswers: Array<ShopResponse<unknown>>
              try {
                let open = times + admins
                const settle = async <T>(p: Promise<T>): Promise<T> => {
                  const out = await p
                  open -= 1
                  return out
                }
                const sent = Promise.all(
                  Array.from({ length: times }, () =>
                    settle(
                      send(shipDelivery({ id: freshId(), updates: [update(n, 'delivered')] })),
                    ),
                  ),
                )
                const called = Promise.all(
                  Array.from({ length: admins }, () => settle(markDelivered(order.id))),
                )
                // With no tracking handler, a lone admin call is held with nothing left to overlap it.
                await hold.releaseWhenOvertaken(async () => {
                  if (open > 1) return false
                  const pending = (await eventRows(raw, 'seq > ?', [seq])).filter(
                    (r) => r.deliveredAt == null && r.deadAt == null,
                  )
                  return pending.length === 0
                })
                deliveries = await sent
                adminAnswers = await called
              } finally {
                hold.restore()
              }
              await delivered()

              const seen = `${times} deliveries, ${admins} admin calls`
              expect(tally(deliveries), seen).toEqual({ received: times, deduped: 0 })
              const moves = (await historyTo(order.id, 'delivered')).map((r) => actorKind(r.actor))
              expect(moves.length, `${seen}: ${JSON.stringify(moves)}`).toBe(1)
              const adminMoved = moves[0] === 'admin' ? 1 : 0
              expect(adminAnswers.map(answerOf).sort(), seen).toEqual(
                [
                  ...Array.from({ length: adminMoved }, () => [200, null]),
                  ...Array.from({ length: admins - adminMoved }, () => [409, INVALID_TRANSITION]),
                ].sort(),
              )
              expect((await orderEvents(order.id, EVT_ORDER_DELIVERED)).length).toBe(1)
              expect(reviewRequests.filter((o) => o === order.id).length).toBe(reviewsBefore + 1)
              expect(await retriedSince(seq)).toEqual([])
            },
          ),
          {
            numRuns: options.propertyRuns,
            examples: [
              [2, 2],
              [2, 1],
            ],
          },
        )
      }, 240_000)
    }

    // ─── AC-6: one parcel, two orders ────────────────────────────────────────────────────────────────────────

    it(`AC-6: two orders shipped with the same N, written differently, both move to delivered on one delivered update, each with one delivered history row by ${TRACKING_ACTOR} (${dialect})`, async () => {
      const n = freshNumber()
      const a = await shippedOrder(
        spell(n, { lower: false, every: 4, tab: false, left: 0, right: 0 }),
      )
      const b = await shippedOrder(
        spell(n, { lower: true, every: 2, tab: true, left: 1, right: 1 }),
        'DHL',
      )

      const answer = await send(shipDelivery({ id: freshId(), updates: [update(n, 'delivered')] }))
      await delivered()

      expect(answer.data, JSON.stringify(answer.body)).toEqual({ received: true, events: 1 })
      expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(['delivered', 'delivered'])
      for (const order of [a, b]) {
        expect((await historyTo(order.id, 'delivered')).map((r) => r.actor)).toEqual([
          TRACKING_ACTOR,
        ])
      }
      const numbers = [...(await shipmentsOf(a.id)), ...(await shipmentsOf(b.id))].map(
        (r) => r.tracking_number,
      )
      expect(numbers).toEqual([canon(n), canon(n)])
    })
  })
}
