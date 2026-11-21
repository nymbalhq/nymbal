import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Order } from '@nymbalhq/types'
import { customerSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  addDays,
  clearReports,
  deliver,
  events,
  noonOf,
  rollupEventArb,
  seedCart,
  seedOrder,
  seedPool,
  storeDay,
  type GrainBody,
  type MoneyRow,
  type Pool,
  type Rate,
  type ReportBody,
} from '../support/report-rollups.js'
import { shopper } from '../support/shopper.js'

// GET /api/admin/reports over a kernel whose rollups the live handler filled. What the route must keep true: a figure
// a model reads cannot be misread, a series ships only when asked for, a part day never enters a total.

const ROUTE = '/api/admin/reports'

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient
let pool: Pool

const today = (): string => storeDay(new Date())
const closedThrough = (): string => addDays(today(), -1)

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
  pool = await seedPool(k)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

beforeEach(async () => {
  await clearReports(k)
})

async function report(query = ''): Promise<ReportBody> {
  const res = await admin.call<ReportBody>('GET', `${ROUTE}${query === '' ? '' : `?${query}`}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function grained(query: string): Promise<GrainBody> {
  const res = await admin.call<GrainBody>('GET', `${ROUTE}?${query}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function deliverAll(events_: Array<Parameters<typeof deliver>[1]>): Promise<void> {
  for (const event of events_) await deliver(k, event)
}

const orderOf = (source: string, currency = 'GBP'): Promise<Order> =>
  seedOrder(k, { source: source as Order['source'], currency })

describe('AC-21: the route refuses what it must, and ships series only when asked', () => {
  it('AC-21: no token is 401, a customer 403; from after to, 32 days of grain=day and 8 of grain=hour are 400, while 31 and 7 are served', async () => {
    const anonymous = await shopper(served.baseUrl).call('GET', ROUTE)
    const customer = await (await customerSession(served.baseUrl)).send('GET', ROUTE)
    const statusOf = async (query: string) =>
      (await admin.call('GET', `${ROUTE}?${query}`)).status

    expect([anonymous.status, customer.status]).toEqual([401, 403])
    expect(await statusOf('from=2026-02-02&to=2026-02-01')).toBe(400)
    expect(await statusOf('grain=day&from=2026-01-01&to=2026-02-01')).toBe(400)
    expect(await statusOf('grain=day&from=2026-01-01&to=2026-01-31')).toBe(200)
    expect(await statusOf('grain=hour&from=2026-01-01&to=2026-01-08')).toBe(400)
    expect(await statusOf('grain=hour&from=2026-01-01&to=2026-01-07')).toBe(200)
  })

  it('AC-21: the default answer has no series anywhere, and a grain read has only window, since, definitions and its series (hour has no funnel)', async () => {
    const def = await report()
    expect(JSON.stringify(def)).not.toContain('"series"')

    const dayKeys = Object.keys(await grained('grain=day')).sort()
    expect(dayKeys).toEqual(['definitions', 'funnel', 'money', 'since', 'window'])
    const hour = await grained('grain=hour')
    expect(Object.keys(hour).sort()).toEqual(['definitions', 'money', 'since', 'window'])
    expect(Array.isArray(hour.money.series)).toBe(true)
  })
})

describe('AC-22: money by currency, closed days only', () => {
  it('AC-22: one row per currency with bySource summing to it and no conversion; today is in no total but is the partial day of grain=day; since is the earliest day with a row, and synthetic appears nowhere', async () => {
    const gbp = await orderOf('storefront')
    const gbpImport = await orderOf('import')
    const eur = await orderOf('storefront', 'EUR')
    const synthetic = await orderOf('synthetic')
    const closed = closedThrough()
    const earlier = addDays(closed, -3)

    await deliverAll([
      events.captured(gbp, 1_000, noonOf(earlier)),
      events.captured(gbpImport, 2_000, noonOf(earlier)),
      events.captured(eur, 5_000, noonOf(closed)),
      events.refunded(gbp, 300, noonOf(closed)),
      events.paid(gbp, noonOf(closed)),
      events.captured(gbp, 77_777, new Date()),
      events.captured(synthetic, 123_456, noonOf(closed)),
    ])

    const body = await report()
    expect(body.window.to).toBe(closed)
    expect(body.window.closedThrough).toBe(closed)
    expect(body.since).toBe(earlier)

    const rowFor = (c: string) => body.money.totals.find((row) => row.currency === c)!
    expect(body.money.totals.map((r) => r.currency).sort()).toEqual(['EUR', 'GBP'])
    const gbpRow = rowFor('GBP')
    expect(gbpRow.capturedMinor).toBe(3_000)
    expect(gbpRow.refundedMinor).toBe(300)
    expect(gbpRow.netCapturedMinor).toBe(gbpRow.capturedMinor - gbpRow.refundedMinor)
    expect(gbpRow.paidOrders).toBe(1)
    expect(rowFor('EUR').capturedMinor).toBe(5_000)
    expect(gbpRow.bySource.reduce((sum, s) => sum + s.capturedMinor, 0)).toBe(gbpRow.capturedMinor)
    expect(gbpRow.bySource.reduce((sum, s) => sum + s.refundedMinor, 0)).toBe(gbpRow.refundedMinor)
    expect(gbpRow.bySource.map((s) => s.source).sort()).toEqual(['import', 'storefront'])

    const series = (await grained('grain=day')).money.series
    const partials = series.filter((row) => row.partial)
    expect(partials.map((row) => row.bucket)).toEqual([today()])
    expect(partials[0]!.capturedMinor).toBe(77_777)

    expect(JSON.stringify(body)).not.toContain('synthetic')
    expect(JSON.stringify(series)).not.toContain('synthetic')
  })
})

describe('AC-17: an hour is part of its day', () => {
  it('AC-17: Σ hours of the UK fall-back day equals the day for every currency and source, and that day has 25 hours', async () => {
    const day = '2026-10-25'
    const first = Date.parse('2026-10-24T23:30:00.000Z')
    const orders = {
      GBP: { storefront: await orderOf('storefront'), import: await orderOf('import') },
      EUR: { storefront: await orderOf('storefront', 'EUR'), import: await orderOf('import', 'EUR') },
    }
    const toDeliver = []
    for (let hour = 0; hour < 25; hour += 1) {
      const at = new Date(first + hour * 3_600_000)
      for (const currency of ['GBP', 'EUR'] as const) {
        const source = hour % 2 === 0 ? 'storefront' : 'import'
        toDeliver.push(events.captured(orders[currency][source], 100 + hour, at))
      }
    }
    await deliverAll(toDeliver)

    const hours = (await grained(`grain=hour&from=${day}&to=${day}`)).money.series
    const days = (await grained(`grain=day&from=${day}&to=${day}`)).money.series
    const sumOf = (rows: MoneyRow[], currency: string, source: string) =>
      rows
        .filter((row) => row.currency === currency)
        .flatMap((row) => row.bySource)
        .filter((row) => row.source === source)
        .reduce((sum, row) => sum + row.capturedMinor, 0)

    expect(new Set(hours.filter((r) => r.currency === 'GBP').map((r) => r.bucket)).size).toBe(25)
    for (const currency of ['GBP', 'EUR']) {
      for (const source of ['storefront', 'import']) {
        expect(sumOf(hours, currency, source)).toBe(sumOf(days, currency, source))
      }
      expect(days.filter((r) => r.currency === currency)).toHaveLength(1)
    }
  })
})

describe('AC-23: rates', () => {
  async function fillFunnel(paid: number, checkouts: number, carts: number, viewers: number) {
    const day = closedThrough()
    const toDeliver = []
    for (let i = 0; i < paid; i += 1) toDeliver.push(events.paid(await orderOf('storefront'), noonOf(day, i)))
    for (let i = 0; i < checkouts; i += 1) toDeliver.push(events.intent(await orderOf('storefront'), noonOf(day, i)))
    for (let i = 0; i < carts; i += 1) toDeliver.push(events.cartAdded(await seedCart(k), noonOf(day, i)))
    for (let i = 0; i < viewers; i += 1) toDeliver.push(events.viewed(`viewer-${randomUUID()}`, noonOf(day, i)))
    await deliverAll(toDeliver)
    return day
  }

  function expectRate(rate: Rate, denominatorKey: 'checkoutsStarted' | 'cartsWithItems' | 'viewers') {
    expect(rate.rate).not.toBeNull()
    expect(rate.rate!).toBeCloseTo(rate.paidOrders / rate[denominatorKey]!, 10)
    expect(rate.basis).toMatch(/storefront/i)
    expect(rate.window).toMatchObject({ to: closedThrough() })
  }

  it('AC-23: at the floors each rate equals its parts over the closed days and counts only storefront orders; an import and an agent order leave it unchanged', async () => {
    await fillFunnel(3, 5, 5, 20)
    await deliverAll([
      events.placed(
        await seedOrder(k, {
          source: 'import',
          capturedMinor: 900,
          createdAt: noonOf(closedThrough()),
        }),
        new Date(),
      ),
      events.paid(await orderOf('agent:scout'), noonOf(closedThrough())),
      events.intent(await orderOf('agent:scout'), noonOf(closedThrough())),
    ])

    const { rates } = await report()

    expect(rates.paidPerCheckoutStarted.paidOrders).toBe(3)
    expect(rates.paidPerCheckoutStarted.checkoutsStarted).toBe(5)
    expect(rates.paidPerCartWithItems.paidOrders).toBe(3)
    expect(rates.paidPerCartWithItems.cartsWithItems).toBe(5)
    expect(rates.paidPerMeasuredViewer.viewers).toBe(20)
    expectRate(rates.paidPerCheckoutStarted, 'checkoutsStarted')
    expectRate(rates.paidPerCartWithItems, 'cartsWithItems')
    expectRate(rates.paidPerMeasuredViewer, 'viewers')
  })

  it('AC-23: one below each floor (19 viewers, 4 checkouts, 4 carts) the rate is null with a reason, not 0 % or 100 %', async () => {
    await fillFunnel(4, 4, 4, 19)

    const { rates } = await report()

    for (const rate of [
      rates.paidPerCheckoutStarted,
      rates.paidPerCartWithItems,
      rates.paidPerMeasuredViewer,
    ]) {
      expect(rate.rate).toBeNull()
      expect(rate.reason).toMatch(/\w/)
    }
  })

  it('AC-23: with no closed day in the range every rate is null with a reason', async () => {
    await fillFunnel(3, 5, 5, 20)

    const { rates } = await report(`from=${today()}&to=${today()}`)

    expect(rates.paidPerCheckoutStarted.rate).toBeNull()
    expect(rates.paidPerCheckoutStarted.reason).toMatch(/\w/)
  })
})

describe('AC-24: nothing a model reads can be misstated', () => {
  const RATE_PARTS = new Set(['rate', 'paidOrders', 'checkoutsStarted', 'cartsWithItems', 'viewers'])

  function walk(
    value: unknown,
    path: string,
    leaf: (key: string, path: string) => void,
    object: (o: Record<string, unknown>, path: string) => void,
  ): void {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, leaf, object))
    else if (value !== null && typeof value === 'object') {
      const o = value as Record<string, unknown>
      object(o, path)
      for (const [key, v] of Object.entries(o)) {
        if (typeof v === 'number') leaf(key, `${path}.${key}`)
        else walk(v, `${path}.${key}`, leaf, object)
      }
    }
  }

  it('AC-24: property: over a generated store every numeric leaf is named in definitions or is part of a rate; every object with a *Minor key has a currency; every section has a window with a timezone; no key says revenue', async () => {
    const now = Date.now()
    const arb = fc.array(
      rollupEventArb(pool, { base: new Date(now - 10 * 86_400_000), hours: 9 * 24 }),
      { minLength: 5, maxLength: 25 },
    )
    await fc.assert(
      fc.asyncProperty(arb, async (generated) => {
        await clearReports(k)
        await deliverAll(generated)

        const body = await report()
        const named = new Set(Object.keys(body.definitions))
        const sections: Record<string, Record<string, unknown>> = {
          moneyRow: (body.money.totals[0] ?? {}) as Record<string, unknown>,
          funnelRow: (body.funnel.totals[0] ?? {}) as Record<string, unknown>,
          topProducts: body.topProducts,
          zeroResultSearches: body.zeroResultSearches,
          stockRunway: body.stockRunway,
        }
        for (const [section, value] of Object.entries(sections)) {
          if (Object.keys(value).length === 0) continue
          expect(value['window'], section).toMatchObject({ timezone: 'Europe/London' })
        }
        for (const rate of Object.values(body.rates)) {
          expect(rate.window).toMatchObject({ timezone: 'Europe/London' })
        }
        walk(
          body,
          '$',
          (key, path) => {
            expect(named.has(key) || RATE_PARTS.has(key), `${path} is named`).toBe(true)
          },
          (o, path) => {
            for (const key of Object.keys(o)) {
              expect(/revenue/i.test(key), `${path}.${key}`).toBe(false)
            }
            const namesMoney = Object.keys(o).some((key) => key.endsWith('Minor'))
            expect(namesMoney && typeof o['currency'] !== 'string', `${path} has a currency`).toBe(false)
          },
        )
      }),
      { numRuns: 6 },
    )
  }, 120_000)
})

describe('AC-25: the lists', () => {
  it('AC-25: topProducts is ordered by units and zeroResultSearches by searches, and limit bounds the three lists', async () => {
    const yesterday = closedThrough()
    const toDeliver = []
    for (const qty of [1, 5, 3]) {
      const seeded = await seedVariant(k, 50)
      toDeliver.push(
        events.paid(
          await seedOrder(k, { lines: [[seeded.variantId, seeded.productId, qty, 100]] }),
          noonOf(yesterday),
        ),
      )
    }
    for (const [term, n] of [
      ['rare miss', 1],
      ['common miss', 4],
      ['medium miss', 2],
    ] as const) {
      for (let i = 0; i < n; i += 1) toDeliver.push(events.searched(term, noonOf(yesterday, i)))
    }
    await deliverAll(toDeliver)

    const all = await report()
    expect(all.topProducts.items.map((p) => p.units)).toEqual([5, 3, 1])
    expect(all.zeroResultSearches.items.map((s) => s.searches)).toEqual([4, 2, 1])
    expect(all.stockRunway.items).toHaveLength(3)

    const bounded = await report('limit=2')
    expect(bounded.topProducts.items.map((p) => p.units)).toEqual([5, 3])
    expect(bounded.zeroResultSearches.items.map((s) => s.searches)).toEqual([4, 2])
    expect(bounded.stockRunway.items).toHaveLength(2)
  })

  async function sell(stock: number, qty: number, day: string) {
    const seeded = await seedVariant(k, stock)
    await deliver(
      k,
      events.paid(
        await seedOrder(k, { lines: [[seeded.variantId, seeded.productId, qty, 100]] }),
        noonOf(day),
      ),
    )
    return seeded
  }

  it('AC-25: daysLeft is stock over the units sold per day of the last 28 closed days; a sale older than the window does not count; no stock is 0 days; an unsold variant is not listed; soonest out first', async () => {
    const closed = closedThrough()
    const steady = await sell(70, 10, addDays(closed, -3))
    await deliver(
      k,
      events.paid(
        await seedOrder(k, { lines: [[steady.variantId, steady.productId, 40, 100]] }),
        noonOf(addDays(closed, -35)),
      ),
    )
    const out = await sell(0, 4, addDays(closed, -1))
    const unsold = await seedVariant(k, 40)

    const { stockRunway, since, window } = await report()

    expect(since).toBe(addDays(closed, -35))
    const steadyRow = stockRunway.items.find((i) => i.variantId === steady.variantId)!
    expect(steadyRow.unitsSold).toBe(10)
    expect(steadyRow.windowDays).toBe(28)
    expect(steadyRow.daysLeft).toBeCloseTo(steadyRow.stock / (steadyRow.unitsSold / steadyRow.windowDays), 5)
    expect(stockRunway.items.find((i) => i.variantId === out.variantId)?.daysLeft).toBe(0)
    expect(stockRunway.items.map((i) => i.variantId)).not.toContain(unsold.variantId)
    expect(stockRunway.items.map((i) => i.variantId)[0]).toBe(out.variantId)
    expect(window.closedThrough).toBe(closed)
  })

  it('AC-25: a store younger than 28 days uses the closed days it has, from since', async () => {
    const closed = closedThrough()
    const firstDay = addDays(closed, -9)
    const seeded = await sell(100, 20, firstDay)

    const { stockRunway, since } = await report()

    expect(since).toBe(firstDay)
    const row = stockRunway.items.find((i) => i.variantId === seeded.variantId)!
    expect(row.windowDays).toBe(10)
    expect(row.daysLeft).toBeCloseTo(row.stock / (row.unitsSold / row.windowDays), 5)
  })
})

describe('AC-29: the default answer fits the assistant’s result', () => {
  it('AC-29: a store selling 12 products from two sources in two currencies over 30 days answers under 16,000 characters', async () => {
    const products = []
    for (let i = 0; i < 12; i += 1) products.push(await seedVariant(k, 500))
    const channels = [
      ['storefront', 'GBP'],
      ['import', 'GBP'],
      ['storefront', 'EUR'],
      ['import', 'EUR'],
    ] as const
    const ordersByChannel = []
    for (const [source, currency] of channels) {
      const orders = []
      for (const [i, product] of products.entries()) {
        orders.push(
          await seedOrder(k, {
            source,
            currency,
            lines: [[product.variantId, product.productId, i + 1, 100]],
          }),
        )
      }
      ordersByChannel.push(orders)
    }
    const toDeliver = []
    for (let i = 1; i <= 30; i += 1) {
      const day = addDays(closedThrough(), -(i - 1))
      for (const orders of ordersByChannel) {
        const order = orders[i % orders.length]!
        toDeliver.push(
          events.captured(order, 1000 + i, noonOf(day)),
          events.paid(order, noonOf(day)),
        )
      }
      toDeliver.push(
        events.searched(`miss number ${i % 15}`, noonOf(day)),
        events.viewed(`viewer-${i}`, noonOf(day)),
      )
    }
    await deliverAll(toDeliver)

    const body = await report()
    expect(body.topProducts.items).toHaveLength(10)
    for (const item of body.topProducts.items) expect(item.bySource).toHaveLength(2)

    const text = JSON.stringify(body)
    expect(text.length).toBeLessThan(16_000)
    expect(JSON.parse(text)).toMatchObject({ window: { closedThrough: closedThrough() } })
  }, 60_000)
})
