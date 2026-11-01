import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'

// A merchant ships an order from the admin: carrier and tracking number asked for in a dialog, sent once however
// often submit is clicked, and the order, its timeline and the API agree that it shipped once.

interface HistoryEntry {
  toStatus: string
  note?: string | null
}

interface OrderRead {
  orderNumber: string
  status: string
  history: HistoryEntry[]
}

async function readOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<OrderRead> {
  const res = await request.get(`${API_URL}/api/admin/orders/${orderNumber}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: OrderRead }).data
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const SHIP_POST = /\/api\/admin\/orders\/[^/]+\/ship$/

/** Counts the page's /ship POSTs; `settled()` waits until every one sent has been answered. */
function watchShipPosts(page: Page): { sent(): number; settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const isShip = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && SHIP_POST.test(new URL(r.url()).pathname)
  page.on('request', (r) => {
    if (isShip(r)) sent += 1
  })
  const onAnswered = (r: { method(): string; url(): string }) => {
    if (isShip(r)) answered += 1
  }
  page.on('requestfinished', onAnswered)
  page.on('requestfailed', onAnswered)
  return {
    sent: () => sent,
    async settled() {
      await expect.poll(() => sent - answered, { message: '/ship POSTs still in flight' }).toBe(0)
    },
  }
}

test.describe('Admin ships an order', () => {
  // Kills: Mark Shipped posting blank carrier and tracking, which the API refuses 400, so the badge stays Processing;
  // a double-clicked submit shipping twice (two timeline entries).
  test('AC-13: a paid order moved to Processing, then Mark Shipped with carrier and tracking and a double-clicked submit, reads Shipped on the page and in the API, with exactly one shipped entry noting the carrier and tracking', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const shopper = await playwrightRequest.newContext()
    let order: Awaited<ReturnType<typeof placeOrder>>
    try {
      // Not `+stub-pending`: the stub pays the order inline.
      order = await placeOrder(
        shopper,
        `e2e-ship-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
      )
    } finally {
      await shopper.dispose()
    }
    const token = await adminToken(request)
    const carrier = 'Royal Mail'
    const tracking = `RM${randomUUID().slice(0, 8).toUpperCase()}GB`

    await signInAsAdmin(page)
    await page.goto(`orders/${order.orderNumber}`)
    const badge = page.getByTestId('admin-order-status-badge')
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })

    await page.getByTestId('admin-order-status-select').click()
    await page.getByTestId('admin-order-status-option-processing').click()
    await expect(badge).toHaveText('Processing', { timeout: 15_000 })

    const posts = watchShipPosts(page)
    await page.getByTestId('admin-order-primary-action').click()
    const dialog = page.getByTestId('admin-order-ship-dialog')
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-order-ship-carrier').fill(carrier)
    await page.getByTestId('admin-order-ship-tracking').fill(tracking)
    await page.getByTestId('admin-order-ship-submit').dblclick()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await posts.settled()

    await expect(badge).toHaveText('Shipped', { timeout: 15_000 })
    const read = await readOrder(request, token, order.orderNumber)
    expect(read.status).toBe('shipped')
    const note = `Shipped via ${carrier}: ${tracking}`
    const shippedInApi = read.history.filter((h) => h.toStatus === 'shipped')
    expect(
      shippedInApi.map((h) => h.note),
      `shipped history entries (${posts.sent()} /ship POSTs sent)`,
    ).toEqual([note])

    await page.getByTestId('admin-order-tab-timeline').click()
    const shippedOnPage = page.getByTestId('admin-order-timeline-entry-shipped')
    await expect(shippedOnPage).toHaveCount(shippedInApi.length)
    // The timeline and the API's history agree: one shipped entry each, with the same note.
    await expect(shippedOnPage).toHaveText(
      shippedInApi.map((h) => new RegExp(escapeRegExp(h.note ?? ''))),
    )
  })
})
