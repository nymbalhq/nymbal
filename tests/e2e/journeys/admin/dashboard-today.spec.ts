import {
  request as playwrightRequest,
  type Page,
  type Request,
  type Response,
} from '@playwright/test'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// AC-9: the dashboard's three today tiles show what the GET /api/admin/dashboard answer the page itself received
// holds, after a paid order and after a partial refund. The store is shared with other admin journeys, so the money is
// compared only to the page's own answer; AC-1 and AC-2 own the arithmetic.

interface Today {
  day: string
  timezone: string
  paidOrders: number
  units: number
  money: Array<{ currency: string; netCapturedMinor: number }>
}

interface DashboardAnswer {
  data: { today: Today }
}

const isDashboard = (res: Response) =>
  new URL(res.url()).pathname === '/api/admin/dashboard' && res.status() === 200

/** The tiles' figures, in the answer's own terms. */
async function tiles(page: Page) {
  const sales = page.getByTestId('admin-dashboard-today-sales')
  return {
    paidOrders: (await page.getByTestId('admin-dashboard-today-paid-orders').textContent())?.trim(),
    netCapturedMinor: await sales.getAttribute('data-minor'),
    currency: await sales.getAttribute('data-currency'),
    units: (await page.getByTestId('admin-dashboard-today-items').textContent())?.trim(),
  }
}

function figuresOf(today: Today) {
  const store = today.money[0]
  return {
    paidOrders: String(today.paidOrders),
    netCapturedMinor: String(store?.netCapturedMinor),
    currency: store?.currency ?? null,
    units: String(today.units),
  }
}

test.describe('The dashboard’s today tiles', () => {
  test('AC-9: on /admin/ the paid orders, sales and items tiles equal the dashboard answer the page received; after a paid order they still do, with paid orders and items at least one and its quantity higher; after a partial refund they still do', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    // The page refetches on a timer and on live events from other journeys, and on connecting to the live stream it
    // cancels the GET in flight and asks again: the tiles follow the answer to the latest request.
    let issued = 0
    let lastIssuedAt = 0
    let latestSeq = 0
    let latest: Today | undefined
    const seqOf = new WeakMap<Request, number>()
    const isDashboardRequest = (req: Request) =>
      new URL(req.url()).pathname === '/api/admin/dashboard' && req.method() === 'GET'
    page.on('request', (req) => {
      if (!isDashboardRequest(req)) return
      issued += 1
      lastIssuedAt = Date.now()
      seqOf.set(req, issued)
    })
    page.on('requestfinished', async (req) => {
      if (!isDashboardRequest(req)) return
      const res = await req.response()
      if (res === null || !isDashboard(res)) return
      const body = (await res.json().catch(() => undefined)) as DashboardAnswer | undefined
      const seq = seqOf.get(req) ?? 0
      if (body !== undefined && seq > latestSeq) {
        latestSeq = seq
        latest = body.data.today
      }
    })
    const live = page.getByTestId('admin-dashboard-live')
    /** The answer the page renders once it settles: live, no request just sent, the newest request answered. */
    const load = async (go: () => Promise<unknown>): Promise<Today> => {
      const from = issued
      await go()
      await expect(live).toHaveAttribute('data-state', 'live', { timeout: 30_000 })
      await expect(async () => {
        expect(Date.now() - lastIssuedAt, 'a dashboard request just sent').toBeGreaterThan(300)
        expect(latestSeq, 'the newest dashboard request answered').toBe(issued)
        expect(latestSeq, 'answered since the load').toBeGreaterThan(from)
      }).toPass({ timeout: 30_000 })
      return latest!
    }
    const tilesFollowTheAnswer = async () => {
      await expect(async () => {
        expect(latest, 'no dashboard answer yet').not.toBeUndefined()
        expect(await tiles(page)).toEqual(figuresOf(latest!))
      }).toPass({ timeout: 15_000 })
    }

    await signInAsAdmin(page)
    const guest = await playwrightRequest.newContext()
    let order: { orderId: string; orderNumber: string }
    let before: Today
    let after: Today
    try {
      // A run that crosses the store's midnight between the two reads starts again once.
      for (let attempt = 0; ; attempt += 1) {
        before = await load(() => page.goto(''))
        await tilesFollowTheAnswer()
        order = await placeOrder(
          guest,
          `e2e-today-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
        )
        after = await load(() => page.reload())
        if (after.day === before.day || attempt === 1) break
      }
    } finally {
      await guest.dispose()
    }
    await tilesFollowTheAnswer()
    expect(after.timezone).toBe(before.timezone)
    expect(after.paidOrders, 'paid orders').toBeGreaterThanOrEqual(before.paidOrders + 1)
    expect(after.units, 'items sold').toBeGreaterThanOrEqual(before.units + 1)

    const token = await adminToken(request)
    const read = await request.get(
      `${API_URL}/api/admin/orders/${encodeURIComponent(order.orderNumber)}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(read.status(), await read.text()).toBe(200)
    const captured = ((await read.json()) as { data: { payment: { capturedMinor: number } } }).data
      .payment.capturedMinor
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part, 'a partial refund').toBeLessThan(captured)
    const refund = await request.post(`${API_URL}/api/admin/orders/${order.orderId}/refund`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: { amountMinor: part },
    })
    expect(refund.status(), await refund.text()).toBe(200)

    await load(() => page.reload())
    await tilesFollowTheAnswer()
  })
})
