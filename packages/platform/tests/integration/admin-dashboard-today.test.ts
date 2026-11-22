import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import type { Order, TodayFigures, TodayMoney } from '@nymbalhq/types'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, cartWith, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import {
  clearReports,
  deliver,
  events,
  rollupEventArb,
  seedOrder,
  seedPool,
  storeDay,
  type GrainBody,
  type Pool,
} from '../support/report-rollups.js'

// GET /api/admin/dashboard's `today`: the store's own day, in store.timezone, read from the report rollups. Every paid
// order of the day counts however many there are, a refund counts on the day it was made, money stays in its own
// currency, and the figures are the ones GET /api/admin/reports gives for the same day.

interface DashboardBody {
  today: TodayFigures
  recentOrders: Array<{ id: string }>
}

const STORE_CURRENCY = 'GBP'

async function dashboard(admin: AdminClient): Promise<DashboardBody> {
  const res = await admin.call<DashboardBody>('GET', '/api/admin/dashboard')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

function rowOf(today: TodayFigures, currency = STORE_CURRENCY): TodayMoney {
  const row = (today.money ?? []).find((r: TodayMoney) => r.currency === currency)
  if (row === undefined) throw new Error(`no ${currency} row in today: ${JSON.stringify(today)}`)
  return row
}

/** A checkout through the services; the stub pays it inline unless the address carries `+stub-pending`. */
async function checkout(k: Kernel, priceMinor: number, qty: number, pending: boolean) {
  const seeded = await seedVariant(k, qty + 2, { priceMinor })
  const tag = randomUUID()
  return k.services.checkout.beginCheckout({
    cartToken: await cartWith(k, seeded, qty),
    email: pending ? `buyer-${tag}+stub-pending@today.test` : `buyer-${tag}@today.test`,
    billingAddress: address,
    shippingAddress: address,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the dashboard’s today on a store in Europe/London', () => {
  let k: Kernel
  let served: ServedKernel
  let admin: AdminClient
  let pool: Pool

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    admin = await adminClient(k, served.baseUrl)
    pool = await seedPool(k)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  const orderPlan = fc.record({
    kind: fc.constantFrom('paid', 'manual', 'unpaid'),
    priceMinor: fc.integer({ min: 1, max: 15_000 }),
    qty: fc.integer({ min: 1, max: 3 }),
    refundPercents: fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 3 }),
  })

  // Kills: figures read from orders by status or created day, an unpaid order counted, a manual payment missed.
  it('AC-1: over generated paid, manually paid and unpaid orders with partial refunds, today moves by exactly the paid count, their units, and the store currency’s captured, refunded and net', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(orderPlan, { minLength: 1, maxLength: 4 }), async (plans) => {
        const before = (await dashboard(admin)).today
        let paid = 0
        let units = 0
        let captured = 0
        let refunded = 0

        for (const plan of plans) {
          const started = await checkout(k, plan.priceMinor, plan.qty, plan.kind !== 'paid')
          if (plan.kind === 'unpaid') continue
          const marked =
            plan.kind === 'manual'
              ? await admin.call('POST', `/api/admin/orders/${started.orderId}/mark-paid`, {})
              : null
          expect(marked?.status ?? 200, JSON.stringify(marked?.body)).toBe(200)
          const orderCaptured = plan.priceMinor * plan.qty
          paid += 1
          units += plan.qty
          captured += orderCaptured
          let orderRefunded = 0
          for (const percent of plan.refundPercents) {
            const amountMinor = Math.min(
              orderCaptured - orderRefunded,
              Math.max(1, Math.round((orderCaptured * percent) / 100)),
            )
            if (amountMinor <= 0) break
            const res = await admin.call('POST', `/api/admin/orders/${started.orderId}/refund`, {
              amountMinor,
            })
            expect(res.status, JSON.stringify(res.body)).toBe(200)
            orderRefunded += amountMinor
          }
          refunded += orderRefunded
        }

        const after = (await dashboard(admin)).today
        expect(after.paidOrders - before.paidOrders, 'paidOrders').toBe(paid)
        expect(after.units - before.units, 'units').toBe(units)
        expect(rowOf(after).capturedMinor - rowOf(before).capturedMinor, 'captured').toBe(captured)
        expect(rowOf(after).refundedMinor - rowOf(before).refundedMinor, 'refunded').toBe(refunded)
        expect(rowOf(after).netCapturedMinor - rowOf(before).netCapturedMinor, 'net').toBe(
          captured - refunded,
        )
      }),
      { numRuns: 6 },
    )
  }, 180_000)

  // Kills: today's figures taken from the newest 200 orders.
  it('AC-4: paying 201 orders today raises paidOrders by exactly 201 and units by their quantities; recentOrders is the first 10 of GET /api/admin/orders?limit=10', async () => {
    const before = (await dashboard(admin)).today
    const seeded = await seedVariant(k, 1_000, { priceMinor: 700 })
    let units = 0
    for (let i = 0; i < 201; i += 1) {
      const qty = 1 + (i % 3)
      await k.services.checkout.beginCheckout({
        cartToken: await cartWith(k, seeded, qty),
        email: `bulk-${randomUUID()}@today.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      units += qty
    }

    const body = await dashboard(admin)
    expect(body.today.paidOrders - before.paidOrders, 'paidOrders').toBe(201)
    expect(body.today.units - before.units, 'units').toBe(units)

    const list = await admin.call<Array<{ id: string }>>('GET', '/api/admin/orders?limit=10')
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(body.recentOrders.map((o) => o.id)).toEqual(
      list.body.data!.slice(0, 10).map((o) => o.id),
    )
  }, 180_000)

  const refundPlan = fc.record({
    priceMinor: fc.integer({ min: 100, max: 15_000 }),
    qty: fc.integer({ min: 1, max: 3 }),
    percent: fc.integer({ min: 1, max: 100 }),
  })

  // Kills: a refund restating the order's day (the order's createdAt rule), a negative day clamped to zero.
  it('AC-2: a refund made today on an order paid on an earlier store day lowers today’s net and raises refundedMinor by the refund, leaves paidOrders and units alone, and can take net below zero', async () => {
    await clearReports(k)
    let refundedToday = 0
    await fc.assert(
      fc.asyncProperty(refundPlan, async (p) => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3 * 86_400_000 })
        let started: Awaited<ReturnType<typeof checkout>>
        try {
          started = await checkout(k, p.priceMinor, p.qty, false)
        } finally {
          vi.useRealTimers()
        }
        const amountMinor = Math.max(1, Math.floor((p.priceMinor * p.qty * p.percent) / 100))
        const before = (await dashboard(admin)).today

        const res = await admin.call('POST', `/api/admin/orders/${started.orderId}/refund`, {
          amountMinor,
        })
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        refundedToday += amountMinor

        const after = (await dashboard(admin)).today
        expect(rowOf(after).refundedMinor - rowOf(before).refundedMinor).toBe(amountMinor)
        expect(rowOf(before).netCapturedMinor - rowOf(after).netCapturedMinor).toBe(amountMinor)
        expect(rowOf(after).capturedMinor).toBe(rowOf(before).capturedMinor)
        expect(after.paidOrders).toBe(before.paidOrders)
        expect(after.units).toBe(before.units)
        // Nothing was captured today since the tables were emptied: the day is the refunds alone.
        expect(rowOf(after).netCapturedMinor).toBe(-refundedToday)
        expect(rowOf(after).netCapturedMinor).toBeLessThan(0)
      }),
      { numRuns: 4 },
    )
  }, 120_000)

  const currencyEvents = fc.array(
    fc.record({
      currency: fc.constantFrom('GBP', 'EUR', 'USD'),
      capturedMinor: fc.integer({ min: 1, max: 50_000 }),
      refundPercent: fc.integer({ min: 0, max: 100 }),
    }),
    { minLength: 1, maxLength: 6 },
  )

  // Kills: currencies merged or converted, the store currency row moved behind EUR, an empty day with no row at all.
  it('AC-5: each currency with activity today is its own row, unconverted, the store currency first and the rest by code; paidOrders counts every currency; an empty day is one zero row in the store currency', async () => {
    await clearReports(k)
    const empty = (await dashboard(admin)).today
    expect(empty.money).toEqual([
      {
        currency: STORE_CURRENCY,
        capturedMinor: 0,
        refundedMinor: 0,
        netCapturedMinor: 0,
        paidOrders: 0,
        bySource: [],
      },
    ])
    expect([empty.paidOrders, empty.units]).toEqual([0, 0])

    await fc.assert(
      fc.asyncProperty(currencyEvents, async (plans) => {
        await clearReports(k)
        const expected = new Map<string, { captured: number; refunded: number; paid: number }>()
        let units = 0
        for (const plan of plans) {
          const order = await seedOrder(k, { currency: plan.currency })
          const refundedMinor = Math.floor((plan.capturedMinor * plan.refundPercent) / 100)
          const now = new Date()
          await deliver(k, events.captured(order, plan.capturedMinor, now))
          await deliver(k, events.paid(order, now))
          if (refundedMinor > 0) await deliver(k, events.refunded(order, refundedMinor, now))
          const sums = expected.get(plan.currency) ?? { captured: 0, refunded: 0, paid: 0 }
          expected.set(plan.currency, {
            captured: sums.captured + plan.capturedMinor,
            refunded: sums.refunded + refundedMinor,
            paid: sums.paid + 1,
          })
          units += order.lineItems.reduce((sum, l) => sum + l.qty, 0)
        }

        const today = (await dashboard(admin)).today
        const others = [...expected.keys()].filter((c) => c !== STORE_CURRENCY).sort()
        expect(today.money.map((r: TodayMoney) => r.currency)).toEqual([STORE_CURRENCY, ...others])
        for (const row of today.money) {
          const sums = expected.get(row.currency) ?? { captured: 0, refunded: 0, paid: 0 }
          expect(row.capturedMinor, `${row.currency} captured`).toBe(sums.captured)
          expect(row.refundedMinor, `${row.currency} refunded`).toBe(sums.refunded)
          expect(row.netCapturedMinor, `${row.currency} net`).toBe(sums.captured - sums.refunded)
          expect(row.paidOrders, `${row.currency} paidOrders`).toBe(sums.paid)
        }
        expect(today.paidOrders).toBe(plans.length)
        expect(today.units).toBe(units)
      }),
      { numRuns: 6 },
    )
  }, 120_000)

  // Kills: the dashboard and the reports API counting today differently.
  it('AC-6: for any events today, each today.money row equals the partial row of GET /api/admin/reports?grain=day for that day, and today.paidOrders equals Σ that series’ paidOrders', async () => {
    const day = storeDay(new Date())
    const window = { base: new Date(`${day}T00:30:00.000Z`), hours: 22 }
    const pick = (row: TodayMoney) => ({
      capturedMinor: row.capturedMinor,
      refundedMinor: row.refundedMinor,
      netCapturedMinor: row.netCapturedMinor,
      paidOrders: row.paidOrders,
      bySource: [...row.bySource].sort((a, b) => a.source.localeCompare(b.source)),
    })

    await fc.assert(
      fc.asyncProperty(
        fc.array(rollupEventArb(pool, window), { minLength: 1, maxLength: 25 }),
        async (evts) => {
          await clearReports(k)
          for (const event of evts) await deliver(k, event)

          const today = (await dashboard(admin)).today
          expect(today.day).toBe(day)
          const res = await admin.call<GrainBody>(
            'GET',
            `/api/admin/reports?grain=day&from=${today.day}&to=${today.day}`,
          )
          expect(res.status, JSON.stringify(res.body)).toBe(200)
          const series = res.body.data!.money.series.filter((row) => row.bucket === today.day)
          expect(series.every((row) => row.partial)).toBe(true)

          const reported = new Map(series.map((row) => [row.currency, row]))
          // Only the store currency may stand without a report row, and then as zeros.
          const zeros = {
            capturedMinor: 0,
            refundedMinor: 0,
            netCapturedMinor: 0,
            paidOrders: 0,
            bySource: [],
          }
          const expected = today.money.map((row: TodayMoney) => {
            const other = reported.get(row.currency)
            const figures =
              other !== undefined
                ? pick(other as unknown as TodayMoney)
                : row.currency === STORE_CURRENCY
                  ? zeros
                  : { reported: 'none' }
            return { currency: row.currency, ...figures }
          })
          expect(
            today.money.map((row: TodayMoney) => ({ currency: row.currency, ...pick(row) })),
          ).toEqual(expected)
          expect(today.money.map((r: TodayMoney) => r.currency)).toEqual(
            expect.arrayContaining([...reported.keys()]),
          )
          expect(today.paidOrders).toBe(series.reduce((sum, row) => sum + row.paidOrders, 0))
        },
      ),
      { numRuns: 6 },
    )
  }, 120_000)

  // Kills: the old fields kept beside the new ones, a money figure without its currency.
  it('AC-7: today has exactly day, timezone, paidOrders, units and money; every money row names its currency; no key under today mentions revenue', async () => {
    await clearReports(k)
    const eur: Order = await seedOrder(k, { currency: 'EUR' })
    await deliver(k, events.captured(eur, 4_200, new Date()))
    await deliver(k, events.paid(eur, new Date()))

    const today = (await dashboard(admin)).today
    expect(Object.keys(today).sort()).toEqual(['day', 'money', 'paidOrders', 'timezone', 'units'])
    expect(today.money.map((row: TodayMoney) => row.currency)).toEqual([STORE_CURRENCY, 'EUR'])
    for (const row of today.money) {
      for (const source of row.bySource) expect(source.currency).toBe(row.currency)
    }

    const keys: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key)
          walk(inner)
        }
      }
    }
    walk(today)
    expect(keys.filter((key) => /revenue/i.test(key))).toEqual([])
  })
})

describe('the dashboard’s today on a store in Pacific/Auckland', () => {
  let k: Kernel
  let served: ServedKernel

  beforeAll(async () => {
    k = await createKernel({
      dialect: 'sqlite',
      configure: (config) => ({
        ...config,
        store: { ...config.store, timezone: 'Pacific/Auckland' },
      }),
    })
    served = await serveKernel(k)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  // Kills: the day taken from the server's midnight or from UTC (a hard-coded UTC passes on a UTC runner otherwise).
  it('AC-3: with orders paid at Auckland 23:59 on 21 Nov and 00:01 on 22 Nov, today at 11:30Z is 2026-11-22 in Pacific/Auckland and counts only the second order', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-21T10:59:00.000Z') })
    await checkout(k, 1_000, 1, false)
    vi.setSystemTime(new Date('2026-11-21T11:01:00.000Z'))
    await checkout(k, 2_500, 2, false)
    vi.setSystemTime(new Date('2026-11-21T11:30:00.000Z'))
    const admin = await adminClient(k, served.baseUrl)
    const { today } = await dashboard(admin)

    expect(today.timezone).toBe('Pacific/Auckland')
    expect(today.day).toBe('2026-11-22')
    expect(today.paidOrders).toBe(1)
    expect(today.units).toBe(2)
    expect(today.money).toHaveLength(1)
    expect(rowOf(today)).toMatchObject({
      currency: STORE_CURRENCY,
      capturedMinor: 5_000,
      refundedMinor: 0,
      netCapturedMinor: 5_000,
      paidOrders: 1,
    })
  }, 60_000)
})
