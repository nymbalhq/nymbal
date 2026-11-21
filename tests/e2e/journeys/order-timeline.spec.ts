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
import { postSignedWebhook } from '../support/webhooks'

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

  // Kills: shopper pages still branching on a money status (a refunded order reads "Order confirmed" and paid), or
  // showing nothing of a refund once the status stays confirmed.
  test('AC-19: a guest order refunded in full reads "Order refunded", shows no paid check, order-payment-state Refunded and order-status the fulfilment status, its timeline ending Refunded; a partly refunded one reads "Order confirmed" with order-payment-state Partially refunded', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 10)

    const refunded = await placeThroughCheckout(page, product, email('ac19-full'))
    const refundedOrder = await apiOrder(request, refunded.orderNumber, keyHeader(refunded.key))
    expect(refundedOrder.status, 'the stub captured the payment').toBe('confirmed')
    const refundedId = await orderIdOf(request, token, refunded.orderNumber)
    await adminPost(request, token, refundedId, 'refund', { amountMinor: refundedOrder.totalMinor })
    await expect
      .poll(
        async () =>
          (await apiOrder(request, refunded.orderNumber, keyHeader(refunded.key))).timeline?.at(-1)
            ?.kind,
        { timeout: 10_000 },
      )
      .toBe('refunded')

    await page.goto(keyedOrderPath(refunded.orderNumber, refunded.key))
    await expect(page.getByTestId('order-heading')).toHaveText(/order refunded/i, {
      timeout: 15_000,
    })
    await expect(page.locator('.confirmation-icon, [class*="checkCircle"]')).toHaveCount(0)
    await expect(page.getByTestId('order-payment-state')).toHaveText(/^\s*Refunded\s*$/)
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i)
    const entries = await shownEntries(page)
    expect(entries.at(-1)?.kind).toBe('refunded')
    expect(entries.at(-1)?.label).toBe(LABELS.refunded)

    const partly = await placeThroughCheckout(page, product, email('ac19-part'))
    const partlyOrder = await apiOrder(request, partly.orderNumber, keyHeader(partly.key))
    const partlyId = await orderIdOf(request, token, partly.orderNumber)
    await adminPost(request, token, partlyId, 'refund', {
      amountMinor: Math.max(1, Math.floor(partlyOrder.totalMinor / 3)),
    })
    await page.goto(keyedOrderPath(partly.orderNumber, partly.key))
    await expect(page.getByTestId('order-heading')).toHaveText(/order confirmed/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-payment-state')).toHaveText(/^\s*Partially refunded\s*$/)
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i)
  })

  // Kills: a provider refund that reaches the tables but not what the shopper reads, or a repeat that moves it again.
  test('AC-15: an order refunded in part by a stub provider webhook reads Partially refunded with its order-status unchanged on /order/<n>, and delivering the same event again changes nothing', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const { orderNumber, key } = await placeThroughCheckout(page, product, email('ac15-provider'))
    const placed = await apiOrder(request, orderNumber, keyHeader(key))
    expect(placed.status, 'the stub captured the payment at checkout').toBe('confirmed')
    const orderRes = await request.get(
      `${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    const intentId = ((await orderRes.json()) as { data: { paymentIntentId: string } }).data
      .paymentIntentId
    const signed = {
      rawBody: JSON.stringify({
        id: `evt_e2e_${randomUUID()}`,
        kind: 'payment.refunded',
        paymentIntentId: intentId,
        refund: {
          id: `re_e2e_${randomUUID()}`,
          amountMinor: Math.max(1, Math.floor(placed.totalMinor / 3)),
        },
      }),
      headers: { 'content-type': 'application/json', 'stripe-signature': 'proof-kit-stub' },
    }

    const delivered = await postSignedWebhook(request, 'stripe', signed)
    expect(delivered.status, JSON.stringify(delivered)).toBe(200)

    await expect
      .poll(async () => (await apiOrder(request, orderNumber, keyHeader(key))).timeline?.at(-1)?.kind, {
        timeout: 10_000,
      })
      .toBe('partially_refunded')
    await page.goto(keyedOrderPath(orderNumber, key))
    await expect(page.getByTestId('order-payment-state')).toHaveText(/^\s*Partially refunded\s*$/, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i)

    await postSignedWebhook(request, 'stripe', signed)
    const again = await apiOrder(request, orderNumber, keyHeader(key))
    expect(again.timeline?.filter((e) => e.kind === 'partially_refunded')).toHaveLength(1)
  })

  // Kills: the account pages leaving the refund out now that the status no longer says it.
  test('AC-19: a signed-in shopper’s account order list and order detail read the payment state of a refunded and of a partly refunded order, and the fulfilment status stays confirmed', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const buyer = email('ac19-account')
    const password = 'TestPassword123!'
    const shopper = await playwrightRequest.newContext()
    try {
      const reg = await shopper.post(`${API_URL}/api/auth/register`, {
        headers: await csrf(shopper),
        data: { email: buyer, password, firstName: 'Paige', lastName: 'Refund' },
      })
      expect(reg.ok(), `POST /api/auth/register: ${await reg.text()}`).toBe(true)
      const { accessToken } = ((await reg.json()) as { data: { accessToken: string } }).data
      const auth = { authorization: `Bearer ${accessToken}` }
      const address = {
        firstName: 'Paige',
        lastName: 'Refund',
        addressLine1: '9 Ledger Row',
        city: 'York',
        region: 'North Yorkshire',
        postalCode: 'YO1 7HH',
        country: 'GB',
      }
      const placeOne = async (): Promise<ApiOrder> => {
        const add = await shopper.post(`${API_URL}/api/cart/items`, {
          headers: { ...(await csrf(shopper)), ...auth },
          data: { variantId: product.variantId, qty: 1 },
        })
        expect(add.ok(), `POST /api/cart/items: ${await add.text()}`).toBe(true)
        const checkout = await shopper.post(`${API_URL}/api/checkout`, {
          headers: { ...(await csrf(shopper)), ...auth },
          data: { email: buyer, billingAddress: address, shippingAddress: address },
        })
        expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
        const { orderNumber } = ((await checkout.json()) as { data: { orderNumber: string } }).data
        return apiOrder(shopper, orderNumber, auth)
      }
      const whole = await placeOne()
      const part = await placeOne()
      expect([whole.status, part.status]).toEqual(['confirmed', 'confirmed'])
      await adminPost(request, token, whole.id, 'refund', { amountMinor: whole.totalMinor })
      await adminPost(request, token, part.id, 'refund', {
        amountMinor: Math.max(1, Math.floor(part.totalMinor / 3)),
      })

      await signIn(page, buyer, password)
      await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
        timeout: 15_000,
      })
      await page.goto('/account/orders')
      await expect(page.getByTestId(`order-payment-state-${whole.orderNumber}`)).toHaveText(
        /^\s*Refunded\s*$/,
        { timeout: 15_000 },
      )
      await expect(page.getByTestId(`order-payment-state-${part.orderNumber}`)).toHaveText(
        /^\s*Partially refunded\s*$/,
      )

      await page.goto(`/account/orders/${encodeURIComponent(whole.orderNumber)}`)
      await expect(page.getByTestId('order-payment-state')).toHaveText(/^\s*Refunded\s*$/, {
        timeout: 15_000,
      })
      await page.goto(`/account/orders/${encodeURIComponent(part.orderNumber)}`)
      await expect(page.getByTestId('order-payment-state')).toHaveText(
        /^\s*Partially refunded\s*$/,
        { timeout: 15_000 },
      )
    } finally {
      await shopper.dispose()
    }
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
