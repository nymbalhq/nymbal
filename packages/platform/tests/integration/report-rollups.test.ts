import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandStore } from '../../src/db/command-store.js'
import { createLogger } from '../../src/logger.js'
import { startEventRetentionSweeper } from '../../src/sweepers/index.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  cartWith,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
} from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  addDays,
  clearReports,
  deliver,
  events,
  noonOf,
  seedOrder,
  storeDay,
} from '../support/report-rollups.js'
import { deliverCapture } from '../support/webhooks.js'


// What the live handler leaves in the tables for one store day: how many viewers, on which day, and that the id of
// nobody is stored beside the count.

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient
const logger = createLogger({ pretty: false, level: 'error' })

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

afterEach(() => {
  vi.useRealTimers()
})

async function funnelRow(day: string, source = 'storefront') {
  const [row] = await raw.rows<{ viewers: unknown; carts_with_items: unknown }>(
    'SELECT viewers, carts_with_items FROM report_funnel_days WHERE local_day = ? AND source = ?',
    [day, source],
  )
  return row
}

async function memberRows() {
  return raw.rows<{ kind: string; local_day: string; member: string }>(
    'SELECT kind, local_day, member FROM report_members',
  )
}

describe('AC-6: viewers are distinct per store day and nobody’s id is stored', () => {
  it('AC-6: a repeat view counts once; a visitor and the customer it signs in as are two; each counts again on another day; the same viewer’s digests of two days cannot be joined, and no report table holds an id', async () => {
    await clearReports(k)
    const day1 = '2026-09-10'
    const day2 = '2026-09-11'
    const visitor = `visitor-${randomUUID()}`
    const customer = `customer-${randomUUID()}`

    await deliver(k, events.viewed(visitor, noonOf(day1)))
    await deliver(k, events.viewed(visitor, noonOf(day1, 30)))
    await deliver(k, events.viewed(customer, noonOf(day1, 45), 'customer'))
    await deliver(k, events.viewed(visitor, noonOf(day2)))

    expect(Number((await funnelRow(day1))!.viewers)).toBe(2)
    expect(Number((await funnelRow(day2))!.viewers)).toBe(1)

    const members = await memberRows()
    const dayOne = members.filter((m) => m.local_day === day1 && m.kind === 'viewer')
    const dayTwo = members.filter((m) => m.local_day === day2 && m.kind === 'viewer')
    expect(dayOne.length).toBe(2)
    expect(dayTwo.length).toBe(1)
    expect(dayOne.map((m) => m.member)).not.toContain(dayTwo[0]!.member)

    const everyRow = JSON.stringify(
      await Promise.all(
        [
          'report_funnel_days',
          'report_members',
          'report_sales_hours',
          'report_product_days',
          'report_search_days',
        ].map((table) => raw.rows(`SELECT * FROM ${table}`)),
      ),
    )
    expect(everyRow).not.toContain(visitor)
    expect(everyRow).not.toContain(customer)
  })
})

describe('AC-11: a late event lands on its own timestamp', () => {
  it('AC-11: an event delivered days after it happened counts on the day of its timestamp, not the day it was delivered', async () => {
    await clearReports(k)
    const today = storeDay(new Date())
    const happened = addDays(today, -5)
    const order = await seedOrder(k)

    await deliver(k, events.captured(order, 2_345, noonOf(happened)))

    const days = await raw.rows<{ local_day: string; captured: unknown }>(
      'SELECT local_day, SUM(captured_minor) AS captured FROM report_sales_hours GROUP BY local_day',
    )
    expect(Object.fromEntries(days.map((d) => [d.local_day, Number(d.captured)]))).toEqual({
      [happened]: 2_345,
    })
  })
})

describe('AC-26: the retention sweep takes the digests and leaves the history', () => {
  it('AC-26: report_members older than the cutoff go, younger ones stay, and no rollup row is deleted', async () => {
    await clearReports(k)
    const realNow = Date.now()
    const oldDay = storeDay(new Date(realNow - 40 * 86_400_000))
    const recentDay = storeDay(new Date(realNow))
    const oldViewer = `old-${randomUUID()}`
    const newViewer = `new-${randomUUID()}`

    vi.useFakeTimers({ toFake: ['Date'], now: realNow - 40 * 86_400_000 })
    await deliver(k, events.viewed(oldViewer, new Date(realNow - 40 * 86_400_000)))
    vi.useRealTimers()
    await deliver(k, events.viewed(newViewer, new Date(realNow)))

    const counters = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => [r['local_day'], Number(r['viewers'])]).sort()
    const before = counters(await raw.rows('SELECT local_day, viewers FROM report_funnel_days'))
    expect((await memberRows()).map((m) => m.local_day).sort()).toEqual([oldDay, recentDay].sort())

    const sweeper = startEventRetentionSweeper({
      store: k.store as CommandStore,
      eventLog: k.repos.eventLog,
      processedEvents: k.repos.processedEvent,
      reportRollup: k.repos.reportRollup,
      logger,
      retentionDays: 30,
      intervalMs: 3_600_000,
    })
    try {
      await sweeper.tick()
    } finally {
      sweeper.stop()
    }

    expect((await memberRows()).map((m) => m.local_day)).toEqual([recentDay])
    expect(counters(await raw.rows('SELECT local_day, viewers FROM report_funnel_days'))).toEqual(
      before,
    )
  })
})

describe('AC-9: over a real journey the rollup holds the store’s money', () => {
  const plan = fc.record({
    priceMinor: fc.integer({ min: 500, max: 20_000 }),
    qty: fc.integer({ min: 1, max: 3 }),
    partialPercent: fc.integer({ min: 1, max: 70 }),
    laterPercent: fc.integer({ min: 1, max: 70 }),
    importCaptured: fc.integer({ min: 100, max: 30_000 }),
    importRefunded: fc.integer({ min: 0, max: 100 }),
  })

  async function placePaid(priceMinor: number, qty: number) {
    const seeded = await seedVariant(k, qty + 2, { priceMinor })
    const started = await k.services.checkout.beginCheckout({
      cartToken: await cartWith(k, seeded, qty),
      email: `paid-${randomUUID()}@reports.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    return { orderId: started.orderId, captured: priceMinor * qty }
  }

  async function netByCurrency(sql: string): Promise<Record<string, number>> {
    const rows = await raw.rows<{ currency: string; net: unknown }>(sql)
    return Object.fromEntries(rows.map((r) => [r.currency, Number(r.net)]))
  }

  it('AC-9: property: after a checkout, a partial refund, a refund on a later day, a cancelled order’s captured-and-refunded payment and an import, Σ net over the report days per currency equals Σ orders captured − refunded', async () => {
    await clearReports(k)
    await fc.assert(
      fc.asyncProperty(plan, async (p) => {
        const partial = await placePaid(p.priceMinor, p.qty)
        const amount = Math.max(1, Math.floor((partial.captured * p.partialPercent) / 100))
        const res = await admin.call('POST', `/api/admin/orders/${partial.orderId}/refund`, {
          amountMinor: amount,
        })
        expect(res.status, JSON.stringify(res.body)).toBe(200)

        const later = await placePaid(p.priceMinor, p.qty)
        const laterAmount = Math.max(1, Math.floor((later.captured * p.laterPercent) / 100))
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 86_400_000 })
        try {
          await k.services.refund.refund({
            orderId: later.orderId,
            amountMinor: laterAmount,
            actor: 'admin:test',
          })
        } finally {
          vi.useRealTimers()
        }

        const seeded = await seedVariant(k, 3, { priceMinor: p.priceMinor })
        const cancelled = await checkoutOf(k, seeded, 1)
        await k.services.checkout.cancel(cancelled.orderId, 'changed their mind')
        const capture = await deliverCapture(served.baseUrl, cancelled)
        expect(capture.data?.['reason']).toBe('order_cancelled_refunded')

        const importedId = uuidv7()
        const importRefunded = Math.floor((p.importCaptured * p.importRefunded) / 100)
        await k.services.order.importOrder({
          orderId: importedId,
          orderNumber: `WC-${importedId.slice(-10)}`,
          status: 'processing',
          customerId: null,
          email: `imported-${importedId}@reports.test`,
          billingAddress: address,
          shippingAddress: address,
          lineItems: [],
          subtotalMinor: p.importCaptured,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor: p.importCaptured,
          currency: 'EUR',
          metadata: {},
          createdAt: new Date('2026-05-01T12:00:00.000Z'),
          capturedMinor: p.importCaptured,
          refundedMinor: importRefunded,
          captureMethod: 'import',
        })
        await k.app.relay.drain()

        expect(
          await netByCurrency(
            'SELECT currency, SUM(captured_minor) - SUM(refunded_minor) AS net FROM report_sales_hours GROUP BY currency',
          ),
        ).toEqual(
          await netByCurrency(
            "SELECT currency, SUM(captured_minor) - SUM(refunded_minor) AS net FROM orders GROUP BY currency HAVING SUM(captured_minor) > 0",
          ),
        )
      }),
      { numRuns: 4 },
    )
  }, 120_000)
})
