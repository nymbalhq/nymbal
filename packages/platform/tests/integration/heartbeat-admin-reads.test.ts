import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderSource, OrderStatus, TodayFigures } from '@nymbalhq/types'
import { contextOf, HEARTBEAT_EMAIL, quotedCheckout, withHeartbeat } from '../support/heartbeat.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { insertOrders } from '../support/listed-orders.js'
import { adminClient, type AdminClient } from '../support/money.js'

// Synthetic orders are the heartbeat's, not the merchant's: the admin's order list and count, its dashboard, its search
// and its live event stream leave them out, and `?source=synthetic` lists exactly them. One order read by its number
// still answers. Orders for the list are written as rows (the reads read rows, not how they came to be); the stream is
// fed by real checkouts.

interface Listed {
  orderNumber: string
  status: OrderStatus
  source: OrderSource
}

interface ListAnswer {
  status: number
  numbers: string[]
  total: number | undefined
  code: string | undefined
}

const REAL_SOURCES: OrderSource[] = ['storefront', 'import', 'agent:shopper-bot']
const STATUSES: OrderStatus[] = ['pending', 'confirmed', 'cancelled', 'shipped']

describe('synthetic orders and the admin reads', () => {
  let k: Kernel
  let served: ServedKernel
  let admin: AdminClient
  let variant: Seeded
  /** Every order written so far, in the order written. */
  const written: Listed[] = []

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', configure: withHeartbeat() })
    served = await serveKernel(k)
    admin = await adminClient(k, served.baseUrl)
    variant = await seedVariant(k, 20)
  }, 60_000)
  afterAll(async () => {
    await served?.stop()
  })

  async function list(query: string): Promise<ListAnswer> {
    const res = await admin.call<Array<{ orderNumber: string }>>(
      'GET',
      `/api/admin/orders?limit=200${query === '' ? '' : `&${query}`}`,
    )
    const meta = (res.body as { meta?: { total?: number } }).meta
    return {
      status: res.status,
      numbers: (res.body.data ?? []).map((o) => o.orderNumber).sort(),
      total: meta?.total,
      code: res.body.error?.code,
    }
  }

  const numbers = (orders: Listed[]): string[] => orders.map((o) => o.orderNumber).sort()
  const real = () => written.filter((o) => o.source !== 'synthetic')
  const synthetic = () => written.filter((o) => o.source === 'synthetic')

  // Kills: the filter missing from list or count, hiding more than synthetic orders, `?source=synthetic` not applied
  // or not combined with the other filters, and the two reads overlapping or leaving an order out.
  it('AC-4: property: with s synthetic and r real orders, the default list holds exactly the r with total r, ?source=synthetic exactly the s with total s, the two are disjoint and together every order, and status and q combine with source as any filter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            source: fc.constantFrom<OrderSource>('synthetic', ...REAL_SOURCES),
            status: fc.constantFrom(...STATUSES),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (specs) => {
          const rows = await insertOrders(
            k,
            specs.map((spec) => ({
              status: spec.status,
              source: spec.source,
              orderNumber: `HB-${randomUUID().slice(0, 12)}`,
            })),
          )
          for (const [i, row] of rows.entries()) {
            written.push({
              orderNumber: row.orderNumber,
              status: row.status,
              source: specs[i]!.source,
            })
          }

          const all = await list('')
          const only = await list('source=synthetic')
          expect(all.status).toBe(200)
          expect(only.status, JSON.stringify(only)).toBe(200)
          expect(all.numbers).toEqual(numbers(real()))
          expect(all.total).toBe(real().length)
          expect(only.numbers).toEqual(numbers(synthetic()))
          expect(only.total).toBe(synthetic().length)
          expect(all.numbers.filter((n) => only.numbers.includes(n))).toEqual([])
          expect([...all.numbers, ...only.numbers].sort()).toEqual(numbers(written))

          const status = specs[0]!.status
          const byStatus = await list(`status=${status}`)
          const syntheticByStatus = await list(`source=synthetic&status=${status}`)
          expect(byStatus.numbers).toEqual(numbers(real().filter((o) => o.status === status)))
          expect(syntheticByStatus.numbers).toEqual(
            numbers(synthetic().filter((o) => o.status === status)),
          )
          expect(syntheticByStatus.total).toBe(syntheticByStatus.numbers.length)

          const one = rows[0]!.orderNumber
          const isSynthetic = specs[0]!.source === 'synthetic'
          expect((await list(`q=${one}`)).numbers).toEqual(isSynthetic ? [] : [one])
          expect((await list(`source=synthetic&q=${one}`)).numbers).toEqual(
            isSynthetic ? [one] : [],
          )
        },
      ),
      { numRuns: 6 },
    )
  }, 120_000)

  // Kills: a source filter that accepts other values (and so silently lists everything, or only them).
  it('AC-4: ?source= any value other than synthetic is refused 400 admin.invalid', async () => {
    for (const value of ['storefront', 'import', 'agent:shopper-bot', 'all']) {
      const answer = await list(`source=${encodeURIComponent(value)}`)
      expect({ value, status: answer.status, code: answer.code }).toEqual({
        value,
        status: 400,
        code: 'admin.invalid',
      })
    }
  })

  // Kills: the dashboard's figures or list counting the synthetic order, or the admin search reading the unfiltered
  // list; an order read by number hidden too.
  it('AC-4: the dashboard counts and lists no synthetic order, admin search finds a real order by number and no synthetic one, and GET /api/admin/orders/:orderNumber still answers a synthetic order', async () => {
    const today = async (): Promise<TodayFigures> => {
      const res = await admin.call<{ today: TodayFigures }>('GET', '/api/admin/dashboard')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!.today
    }
    const net = (figures: TodayFigures): number =>
      figures.money.find((row) => row.currency === k.config.store.currency)?.netCapturedMinor ?? 0

    // Today's figures come from payments, so the store check and a paid storefront order go through the checkout.
    const before = await today()
    const check = await quotedCheckout(served.baseUrl, variant, HEARTBEAT_EMAIL)
    expect(check.answer.body.error?.code, JSON.stringify(check.answer.body)).toBe(
      'checkout.synthetic',
    )
    const paid = await quotedCheckout(served.baseUrl, variant, `buyer-${randomUUID()}@shop.test`)
    expect(paid.answer.status, JSON.stringify(paid.answer.body)).toBe(200)
    const after = await today()
    expect({
      paidOrders: after.paidOrders - before.paidOrders,
      units: after.units - before.units,
      netCapturedMinor: net(after) - net(before),
    }).toEqual({ paidOrders: 1, units: 1, netCapturedMinor: paid.answer.body.data!.totalMinor })
    written.push(
      {
        orderNumber: contextOf(check.answer)['orderNumber'] as string,
        status: 'cancelled',
        source: 'synthetic',
      },
      {
        orderNumber: paid.answer.body.data!.orderNumber,
        status: 'confirmed',
        source: 'storefront',
      },
    )

    const [realOne, syntheticOne] = await insertOrders(k, [
      { status: 'confirmed', source: 'storefront', orderNumber: `HB-${randomUUID().slice(0, 12)}` },
      { status: 'cancelled', source: 'synthetic', orderNumber: `HB-${randomUUID().slice(0, 12)}` },
    ])
    written.push(
      { orderNumber: realOne!.orderNumber, status: 'confirmed', source: 'storefront' },
      { orderNumber: syntheticOne!.orderNumber, status: 'cancelled', source: 'synthetic' },
    )

    const dashboard = await admin.call<{
      recentOrders: Array<{ orderNumber: string; source?: string }>
    }>('GET', '/api/admin/dashboard')
    expect(dashboard.status).toBe(200)
    const recent = dashboard.body.data!.recentOrders.map((o) => o.orderNumber)
    expect(recent.filter((n) => numbers(synthetic()).includes(n))).toEqual([])
    expect(recent).toContain(realOne!.orderNumber)

    const search = async (q: string) =>
      (
        await admin.call<{ orders: Array<{ orderNumber: string }> }>(
          'GET',
          `/api/admin/search?q=${encodeURIComponent(q)}`,
        )
      ).body.data!.orders.map((o) => o.orderNumber)
    expect(await search(realOne!.orderNumber)).toEqual([realOne!.orderNumber])
    expect(await search(syntheticOne!.orderNumber)).toEqual([])

    const read = await admin.call<{ orderNumber: string; status: string; source: string }>(
      'GET',
      `/api/admin/orders/${syntheticOne!.orderNumber}`,
    )
    expect(read.status).toBe(200)
    expect(read.body.data).toMatchObject({
      orderNumber: syntheticOne!.orderNumber,
      status: 'cancelled',
      source: 'synthetic',
    })
  })
})

// ─── The live stream ────────────────────────────────────────────────────────────────────────────────────────────────

interface Tab {
  frames: Array<{ event: string; data: unknown }>
  close(): void
}

/** An admin SSE connection, as the admin app opens one: a fresh ticket, then GET /api/admin/events?ticket=. */
async function openTab(baseUrl: string, admin: AdminClient): Promise<Tab> {
  const ticket = await admin.call<{ ticket: string }>('POST', '/api/admin/events/ticket')
  if (ticket.status !== 200) throw new Error(`ticket: ${JSON.stringify(ticket.body)}`)
  const abort = new AbortController()
  const res = await fetch(
    `${baseUrl}/api/admin/events?ticket=${encodeURIComponent(ticket.body.data!.ticket)}`,
    { signal: abort.signal, headers: { accept: 'text/event-stream' } },
  )
  const tab: Tab = { frames: [], close: () => abort.abort() }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message'
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data: ?/, ''))
            .join('\n')
          tab.frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })()
  return tab
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('synthetic orders and the admin event stream', () => {
  let k: Kernel
  let served: ServedKernel
  let variant: Seeded
  let tab: Tab | undefined

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite', configure: withHeartbeat() })
    served = await serveKernel(k)
    variant = await seedVariant(k, 20)
  }, 60_000)
  afterAll(async () => {
    tab?.close()
    await served?.stop()
  })

  // Kills: the live list and its "placed by" toast showing the heartbeat's order every run; or a filter that drops
  // real orders from the stream with it.
  it('AC-5: a stream open across a store check and then a storefront checkout receives the storefront order’s order.placed.v1 and none for the synthetic order', async () => {
    const admin = await adminClient(k, served.baseUrl)
    tab = await openTab(served.baseUrl, admin)
    await until(() => tab!.frames.some((f) => f.event === 'connected'), 'the stream to connect')

    const check = await quotedCheckout(served.baseUrl, variant, HEARTBEAT_EMAIL)
    expect(check.answer.status, JSON.stringify(check.answer.body)).toBe(409)
    expect(check.answer.body.error?.code).toBe('checkout.synthetic')
    const syntheticNumber = contextOf(check.answer)['orderNumber'] as string
    const real = await quotedCheckout(served.baseUrl, variant, `buyer-${randomUUID()}@shop.test`)
    expect(real.answer.status, JSON.stringify(real.answer.body)).toBe(200)
    const realNumber = real.answer.body.data!.orderNumber

    const placed = () =>
      tab!.frames
        .filter((f) => f.event === 'order.placed.v1')
        .map(
          (f) =>
            (f.data as { payload: { order: { orderNumber: string } } }).payload.order.orderNumber,
        )
    // Events reach the stream in the order they were written: once the storefront order's is here, the store check's
    // would have come first.
    await until(() => placed().includes(realNumber), 'the storefront order on the stream')
    expect(placed()).toEqual([realNumber])
    expect(placed()).not.toContain(syntheticNumber)
  }, 60_000)
})
