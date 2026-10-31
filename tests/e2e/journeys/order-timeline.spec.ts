import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
  type OwnProduct,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { signIn } from '../support/sign-in'

// The order timeline on both templates (the astro and nextjs projects run this file), driven only through the
// product: the storefront's checkout and the admin API's commands. The guest confirmation page `/order/<n>` and the
// account order detail show `nymbal-order-timeline`, one `timeline-entry` per lifecycle event of the order, oldest
// first, each with its kind's label and a `datetime` equal to the API's `timeline[i].at`. A pending guest page's own
// poll brings in "Payment received" once the admin records the payment.

const LABELS: Record<string, string> = {
  placed: 'Order placed',
  paid: 'Payment received',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
}

/** The admin history's event types that are a timeline entry, and the entry each is. */
const LIFECYCLE: Record<string, string> = {
  'order.placed.v1': 'placed',
  'order.paid.v1': 'paid',
  'order.shipped.v1': 'shipped',
  'order.delivered.v1': 'delivered',
  'order.cancelled.v1': 'cancelled',
  'order.partially_refunded.v1': 'partially_refunded',
  'order.refunded.v1': 'refunded',
}

interface ApiOrder {
  id: string
  orderNumber: string
  status: string
  totalMinor: number
  timeline?: Array<{ kind: string; at: string }>
}

const email = (tag: string, trigger = '') =>
  `e2e-timeline-${tag}-${randomUUID().slice(0, 8)}${trigger}@e2e.test`

async function apiOrder(
  request: APIRequestContext,
  orderNumber: string,
  headers: Record<string, string> = {},
): Promise<ApiOrder> {
  const res = await request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers,
  })
  expect(res.status(), `GET /api/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ApiOrder }).data
}

/** A guest's read of its own order: the key the confirmation page's URL carries. */
const keyHeader = (key: string) => ({ [ORDER_KEY_HEADER]: key })

/** The order's id, from the admin's read: a key holder's read of the order carries none. */
async function orderIdOf(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<string> {
  const res = await request.get(`${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** One admin command on the order, through the admin API. */
async function adminPost(
  request: APIRequestContext,
  token: string,
  orderId: string,
  command: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const res = await request.post(`${API_URL}/api/admin/orders/${orderId}/${command}`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data,
  })
  expect(res.status(), `POST /api/admin/orders/:id/${command}: ${await res.text()}`).toBe(200)
}

async function refundableMinor(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<number> {
  const res = await request.get(`${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: { payment: { refundableMinor: number } } }).data.payment
    .refundableMinor
}

/** The order's lifecycle kinds from the admin's event history, oldest first. */
async function lifecycleKinds(
  request: APIRequestContext,
  token: string,
  orderId: string,
): Promise<string[]> {
  const res = await request.get(`${API_URL}/api/admin/orders/${orderId}/history?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/orders/:id/history: ${await res.text()}`).toBe(200)
  const entries = ((await res.json()) as { data: { entries: Array<{ type: string }> } }).data
    .entries
  return [...entries]
    .reverse()
    .map((e) => LIFECYCLE[e.type])
    .filter((kind): kind is string => kind !== undefined)
}

/** What each `timeline-entry` on the page shows: its kind, its label and its `datetime`. */
function shownEntries(page: Page): Promise<Array<{ kind: string; label: string; at: string }>> {
  return page.getByTestId('timeline-entry').evaluateAll((els) =>
    els.map((li) => ({
      kind: li.getAttribute('data-kind') ?? '',
      label: (li.querySelector('[part~="label"]')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      at: li.querySelector('time')?.getAttribute('datetime') ?? '',
    })),
  )
}

async function placeThroughCheckout(page: Page, product: OwnProduct, buyer: string) {
  await openCheckout(page, product)
  await walkToPayment(page, buyer)
  await page.getByTestId('place-order').click()
  await page.waitForURL(/\/order\//, { timeout: 20_000 })
  return { orderNumber: orderNumberOf(page), key: orderKeyOf(page) }
}

test.describe('The order timeline', () => {
  // Kills: a template that does not render the element or renders `history[]` raw, an API that does not serve
  // `timeline`, and a refund that shows as the wrong kind or not at all.
  test('AC-4: a captured guest order processed, shipped, delivered, refunded in part twice and then in full shows seven timeline entries on /order/<n>, labelled per kind, each datetime the API’s timeline at, the kinds the admin history’s lifecycle events oldest first', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const { orderNumber, key } = await placeThroughCheckout(page, product, email('ac4'))
    const placed = await apiOrder(request, orderNumber, keyHeader(key))
    expect(placed.status, 'the stub captured the payment at checkout').toBe('confirmed')
    const orderId = await orderIdOf(request, token, orderNumber)

    await adminPost(request, token, orderId, 'process')
    await adminPost(request, token, orderId, 'ship', {
      carrier: 'royal-mail',
      trackingNumber: `TRK-${randomUUID().slice(0, 8)}`,
    })
    await adminPost(request, token, orderId, 'mark-delivered')
    const part = Math.floor(placed.totalMinor / 4)
    await adminPost(request, token, orderId, 'refund', { amountMinor: part })
    await adminPost(request, token, orderId, 'refund', { amountMinor: part })
    const rest = await refundableMinor(request, token, orderNumber)
    expect(rest, 'what is left after two partial refunds').toBe(placed.totalMinor - 2 * part)
    await adminPost(request, token, orderId, 'refund', { amountMinor: rest })
    // The admin's routes read the command store, which holds every command's row once it answers; the served
    // timeline reads the read side, which has caught up once it has an entry for each lifecycle event in the log.
    const lifecycle = await lifecycleKinds(request, token, orderId)
    await expect
      .poll(async () => (await apiOrder(request, orderNumber, keyHeader(key))).timeline?.length, {
        timeout: 10_000,
      })
      .toBe(lifecycle.length)

    await page.goto(keyedOrderPath(orderNumber, key))
    const entries = page.getByTestId('timeline-entry')
    await expect(entries).toHaveCount(7, { timeout: 15_000 })
    const kinds = [
      'placed',
      'paid',
      'shipped',
      'delivered',
      'partially_refunded',
      'partially_refunded',
      'refunded',
    ]
    const shown = await shownEntries(page)
    expect(shown.map((e) => e.kind)).toEqual(kinds)
    expect(shown.map((e) => e.label)).toEqual(kinds.map((k) => LABELS[k]))

    const served = await apiOrder(request, orderNumber, keyHeader(key))
    expect(
      shown.map((e) => e.at),
      'datetime of each entry',
    ).toEqual((served.timeline ?? []).map((e) => e.at))
    expect(
      shown.map((e) => e.kind),
      'the admin history’s lifecycle events',
    ).toEqual(await lifecycleKinds(request, token, orderId))
  })

  // Kills: Next's wrapper keeping its first `entries` after `router.refresh()`, a re-render from a doc with the new
  // status but not its row, and a poll that stops before the payment lands.
  test('AC-5: a +stub-pending guest order’s /order/<n> shows "Order placed"; the admin’s mark-paid brings in "Payment received" and the heading "Order confirmed" within the page’s poll, with no reload by the test', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    // Everything slow comes first, so the page's 10 s poll is spent waiting for the payment alone.
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const { orderNumber, key } = await placeThroughCheckout(
      page,
      product,
      email('ac5', '+stub-pending'),
    )

    const labels = page.getByTestId('timeline-entry').locator('[part~="label"]')
    await expect(labels).toHaveText(['Order placed'], { timeout: 5_000 })
    const pending = await apiOrder(request, orderNumber, keyHeader(key))
    expect(pending.status).toBe('pending')

    await adminPost(request, token, await orderIdOf(request, token, orderNumber), 'mark-paid')
    await expect(labels).toHaveText(['Order placed', 'Payment received'], { timeout: 10_000 })
    await expect(page.getByTestId('order-heading')).toHaveText(/order confirmed/i)
    const served = await apiOrder(request, orderNumber, keyHeader(key))
    expect(
      (await shownEntries(page)).map((e) => e.at),
      'datetime of each entry',
    ).toEqual((served.timeline ?? []).map((e) => e.at))
  })

  // Kills: an account page that does not render the element, passes `history` for `entries`, or defines no element
  // (Astro builds the page with innerHTML).
  test('AC-6: a signed-in shopper’s +stub-pending order cancelled by the admin shows "Order placed" then "Cancelled" on /account/orders/<n>, equal in kind and datetime to GET /api/orders/:n’s timeline', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const buyer = email('ac6', '+stub-pending')
    const password = 'TestPassword123!'
    const shopper = await playwrightRequest.newContext()
    try {
      const reg = await shopper.post(`${API_URL}/api/auth/register`, {
        headers: await csrf(shopper),
        data: { email: buyer, password, firstName: 'Tima', lastName: 'Line' },
      })
      expect(reg.ok(), `POST /api/auth/register: ${await reg.text()}`).toBe(true)
      const { accessToken } = ((await reg.json()) as { data: { accessToken: string } }).data
      const auth = { authorization: `Bearer ${accessToken}` }
      const add = await shopper.post(`${API_URL}/api/cart/items`, {
        headers: { ...(await csrf(shopper)), ...auth },
        data: { variantId: product.variantId, qty: 1 },
      })
      expect(add.ok(), `POST /api/cart/items: ${await add.text()}`).toBe(true)
      const address = {
        firstName: 'Tima',
        lastName: 'Line',
        addressLine1: '3 Timeline Walk',
        city: 'York',
        region: 'North Yorkshire',
        postalCode: 'YO1 7HH',
        country: 'GB',
      }
      const checkout = await shopper.post(`${API_URL}/api/checkout`, {
        headers: { ...(await csrf(shopper)), ...auth },
        data: { email: buyer, billingAddress: address, shippingAddress: address },
      })
      expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
      const { orderNumber } = ((await checkout.json()) as { data: { orderNumber: string } }).data
      const pending = await apiOrder(shopper, orderNumber, auth)
      expect(pending.status).toBe('pending')

      await adminPost(request, token, pending.id, 'cancel', { reason: 'Out of stock' })
      await expect
        .poll(async () => (await apiOrder(shopper, orderNumber, auth)).status, { timeout: 10_000 })
        .toBe('cancelled')

      await signIn(page, buyer, password)
      await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
        timeout: 15_000,
      })
      await page.goto(`/account/orders/${encodeURIComponent(orderNumber)}`)
      const labels = page.getByTestId('timeline-entry').locator('[part~="label"]')
      await expect(labels).toHaveText(['Order placed', 'Cancelled'], { timeout: 15_000 })

      const served = await apiOrder(shopper, orderNumber, auth)
      expect(
        (await shownEntries(page)).map(({ kind, at }) => ({ kind, at })),
        'the page’s entries against the API’s timeline',
      ).toEqual(served.timeline ?? [])
    } finally {
      await shopper.dispose()
    }
  })
})
