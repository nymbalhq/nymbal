import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { placeOrder, realtimeConnected, signInAsAdmin, watchRealtime } from '../support/admin'
import { isCustomProject } from '../support/capabilities'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { HEARTBEAT_ADDRESS, HEARTBEAT_EMAIL } from '../fixtures/custom-providers/heartbeat'

// The heartbeat's store check as the merchant sees it. The custom store (tests/e2e/fixtures/custom-providers) has the
// heartbeat on with its address set: a quote and a checkout with that address, as `nymbal heartbeat` sends them, is
// placed and cancelled by the store and never reaches the admin's open orders list or its notifications, while an
// order placed next does, live. The native store has no heartbeat: there the address is an ordinary shopper's
// (@capabilities: each store asserts its own branch).

const ADMIN_BASE = `${API_URL}/admin/`

interface Answer {
  status: number
  body: {
    data?: { orderNumber?: string }
    error?: { code?: string; context?: { orderNumber?: string } }
  }
}

/** One unit of `product` in a fresh guest cart, a quote for the heartbeat address, then a checkout at that quote. */
async function storeCheck(product: OwnProduct): Promise<Answer> {
  const guest = await playwrightRequest.newContext()
  try {
    const added = await guest.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(guest),
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
    const quoted = await guest.post(`${API_URL}/api/checkout/quote`, {
      headers: await csrf(guest),
      data: { shippingAddress: HEARTBEAT_ADDRESS, email: HEARTBEAT_EMAIL },
    })
    expect(quoted.ok(), `POST /api/checkout/quote: ${await quoted.text()}`).toBe(true)
    const quote = (
      (await quoted.json()) as {
        data: { shippingOptionId: string; totals: { totalMinor: number } }
      }
    ).data
    const res = await guest.post(`${API_URL}/api/checkout`, {
      headers: await csrf(guest),
      data: {
        email: HEARTBEAT_EMAIL,
        billingAddress: HEARTBEAT_ADDRESS,
        shippingAddress: HEARTBEAT_ADDRESS,
        expectedTotalMinor: quote.totals.totalMinor,
        shippingOptionId: quote.shippingOptionId,
      },
    })
    return { status: res.status(), body: (await res.json()) as Answer['body'] }
  } finally {
    await guest.dispose()
  }
}

/** An order of a product of its own, placed by a guest of its own through the API. */
async function shopperOrder(): Promise<{ orderNumber: string }> {
  const guest = await playwrightRequest.newContext()
  try {
    return await placeOrder(guest)
  } finally {
    await guest.dispose()
  }
}

function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

async function syntheticListed(
  request: APIRequestContext,
  token: string,
): Promise<{ orders: Array<{ orderNumber: string; status: string }>; total: number }> {
  const res = await request.get(`${API_URL}/api/admin/orders?source=synthetic&limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/orders?source=synthetic: ${await res.text()}`).toBe(200)
  const body = (await res.json()) as {
    data: Array<{ orderNumber: string; status: string }>
    meta: { total: number }
  }
  return { orders: body.data, total: body.meta.total }
}

test.describe('The heartbeat’s store check stays out of the admin', () => {
  test('AC-6: heartbeat store check on the custom store, with the orders list open, adds no row and no "placed by" notification and is listed cancelled under ?source=synthetic, while an order placed next appears in the open list without a reload @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    if (!isCustomProject(testInfo.project.name)) {
      // The native store has no heartbeat: the address is an ordinary shopper's, and its order is placed.
      const ordinary = await storeCheck(product)
      expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200)
      return
    }

    await watchRealtime(page)
    await signInAsAdmin(page, ADMIN_BASE)
    await page.goto(new URL('orders', ADMIN_BASE).href)
    await realtimeConnected(page)
    const loads = countLoads(page)
    const syntheticBefore = (await syntheticListed(request, token)).total

    const check = await storeCheck(product)
    expect(check.status, JSON.stringify(check.body)).toBe(409)
    expect(check.body.error?.code).toBe('checkout.synthetic')
    const syntheticNumber = check.body.error?.context?.orderNumber ?? ''
    expect(syntheticNumber).toMatch(/\S/)

    const real = await shopperOrder()
    await expect(page.getByTestId(`admin-orders-row-${real.orderNumber}`)).toContainText(
      real.orderNumber,
      {
        timeout: 15_000,
      },
    )
    await expect(page.getByTestId(`admin-orders-row-${syntheticNumber}`)).toHaveCount(0)
    expect(loads(), 'page loads on the orders list').toBe(0)

    await page.getByRole('button', { name: 'Notifications' }).click()
    await expect(page.getByText(`Order #${real.orderNumber} placed by`)).toHaveCount(1)
    await expect(page.getByText(`Order #${syntheticNumber} placed by`)).toHaveCount(0)

    const listed = await syntheticListed(request, token)
    expect(listed.total, 'the store check adds exactly one synthetic order').toBe(
      syntheticBefore + 1,
    )
    expect(
      listed.orders.filter((o) => o.orderNumber === syntheticNumber).map((o) => o.status),
    ).toEqual(['cancelled'])
    expect(listed.orders.map((o) => o.orderNumber)).not.toContain(real.orderNumber)
  })
})
