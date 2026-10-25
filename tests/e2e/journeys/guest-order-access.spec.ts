import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext, Browser, Page, TestInfo } from '@playwright/test'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { formatPrice } from '../support/variants'

// AC-7 to AC-11 on both templates (the astro and nextjs projects run this file): a guest's order is read with the key
// its checkout answered, which the confirmation URL carries (`/order/<n>?key=<k>`, the email link's form too), and by
// nobody without it. The page keeps the order across a reload and in a new browser, the pending page's poll follows
// the payment, a resubmit lands on a keyed page, and no request the browser makes from the order page refers the key
// on. State moves only through product routes: the checkout, and the admin's mark-paid.

const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/

interface ApiOrder {
  id: string
  orderNumber: string
  status: string
  email: string
  totalMinor: number
  currency: string
  shippingAddress: { addressLine1: string }
}

const email = (tag: string, trigger = '') =>
  `e2e-guest-${tag}-${randomUUID().slice(0, 8)}${trigger}@e2e.test`

/** A guest checkout of a product of the test's own, up to the page the checkout lands on. */
async function placeAsGuest(
  page: Page,
  request: APIRequestContext,
  token: string,
  buyer: string,
): Promise<string> {
  const product = await ownProduct(request, token, 5)
  await openCheckout(page, product)
  await walkToPayment(page, buyer)
  await page.getByTestId('place-order').click()
  await page.waitForURL(/\/order\//, { timeout: 20_000 })
  return orderNumberOf(page)
}

function apiOrder(request: APIRequestContext, orderNumber: string, key?: string) {
  return request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers: key === undefined ? {} : { [ORDER_KEY_HEADER]: key },
  })
}

/** The order as the admin reads it: what a page or a response must not leak. */
async function adminOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<ApiOrder> {
  const res = await request.get(`${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ApiOrder }).data
}

/** The body `GET /api/orders/<prefix>-999999999` answers, a number no order has, with `orderNumber` in its place. */
async function notFoundBody(request: APIRequestContext, orderNumber: string): Promise<unknown> {
  const unknown = orderNumber.replace(/[0-9]+$/, '999999999')
  const res = await request.get(`${API_URL}/api/orders/${encodeURIComponent(unknown)}`)
  expect(res.status(), `${unknown}: a number no order has`).toBe(404)
  return JSON.parse((await res.text()).replaceAll(unknown, orderNumber)) as unknown
}

/** A browser with no cookies and no storage: the email link opened somewhere else. */
async function freshBrowser(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const baseURL = testInfo.project.use.baseURL
  const context = await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
  return context.newPage()
}

/** 43 base64url characters that open no order. */
const otherKey = (): string => randomBytes(32).toString('base64url')

test.describe('Guest order access', () => {
  // Kills: a redirect that drops the key; a server render that does not forward it; a page that needs the cart cookie
  // or a session.
  test('AC-7: a guest checkout lands on /order/<n>?key=<k> with a 43-character key; the page shows n, and still does after a reload; /order/<n>?key=<k> in a new browser with no cookies or storage shows n and the order’s total; GET /api/orders/:n with the key answers the order', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const orderNumber = await placeAsGuest(page, request, token, email('ac7'))
    const key = orderKeyOf(page)
    expect(key).toMatch(ORDER_KEY)

    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    await page.reload()
    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })

    const res = await apiOrder(request, orderNumber, key)
    expect(res.status(), `GET /api/orders/${orderNumber} with its key: ${await res.text()}`).toBe(
      200,
    )
    const order = ((await res.json()) as { data: ApiOrder }).data
    expect(order.orderNumber).toBe(orderNumber)

    const elsewhere = await freshBrowser(browser, testInfo)
    try {
      await elsewhere.goto(keyedOrderPath(orderNumber, key))
      await expect(elsewhere.getByTestId('order-number')).toHaveText(orderNumber, {
        timeout: 15_000,
      })
      await expect(elsewhere.getByTestId('order-summary')).toContainText(
        formatPrice(order.totalMinor, order.currency),
      )
    } finally {
      await elsewhere.context().close()
    }
  })

  // Kills: an order page rendered with no key or a wrong one; the API serving the order; a 404 that differs from an
  // unknown number's and so says the order exists.
  test('AC-8: in a new browser, /order/<n> and /order/<n>?key=<another key> each show the not-found page at their own URL with status 404 and none of the order’s email or address; GET /api/orders/:n with no key and with the wrong key answers 404 with the body of a number no order has', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const orderNumber = await placeAsGuest(page, request, token, email('ac8'))
    const order = await adminOrder(request, token, orderNumber)
    const secrets = [order.email, order.shippingAddress.addressLine1]
    const wrong = otherKey()

    const stranger = await freshBrowser(browser, testInfo)
    try {
      for (const path of [
        `/order/${encodeURIComponent(orderNumber)}`,
        keyedOrderPath(orderNumber, wrong),
      ]) {
        const res = await stranger.goto(path)
        expect(res, path).not.toBeNull()
        expect(res!.request().redirectedFrom(), `${path} answers without a redirect`).toBeNull()
        const at = new URL(res!.url())
        expect(at.pathname + at.search, path).toBe(path)
        expect(res!.status(), path).toBe(404)
        await expect(stranger.getByTestId('site-header'), path).toBeVisible({ timeout: 10_000 })
        await expect(stranger.locator('body'), path).toContainText(/404|not found/i)
        const served = await res!.text()
        const shown = await stranger.content()
        for (const secret of secrets) {
          expect(served.includes(secret), `${path}: the HTML served carries ${secret}`).toBe(false)
          expect(shown.includes(secret), `${path}: the page carries ${secret}`).toBe(false)
        }
      }
    } finally {
      await stranger.context().close()
    }

    const expected = await notFoundBody(request, orderNumber)
    for (const [label, key] of [
      ['no key', undefined],
      ['the wrong key', wrong],
    ] as const) {
      const res = await apiOrder(request, orderNumber, key)
      expect(res.status(), `GET /api/orders/${orderNumber} with ${label}`).toBe(404)
      expect(await res.json(), `GET /api/orders/${orderNumber} with ${label}`).toEqual(expected)
    }
  })

  // Kills: a poll that reads the order without the key, so every read is not found and the page stays pending.
  test('AC-9: a +stub-pending guest order’s /order/<n>?key=<k> shows it awaiting payment; the admin’s mark-paid while it is open turns it to "Order confirmed" within the page’s poll, with no reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    // Taken first, so recording the payment does not wait on a login inside the poll's window.
    const token = await adminToken(request)
    const orderNumber = await placeAsGuest(page, request, token, email('ac9', '+stub-pending'))
    expect(orderKeyOf(page)).toMatch(ORDER_KEY)
    await expect(page.getByTestId('order-heading')).toHaveText(/awaiting payment/i, {
      timeout: 15_000,
    })
    const { id } = await adminOrder(request, token, orderNumber)

    const paid = await request.post(`${API_URL}/api/admin/orders/${id}/mark-paid`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: {},
    })
    expect(paid.status(), `POST /api/admin/orders/${id}/mark-paid: ${await paid.text()}`).toBe(200)

    await expect(page.getByTestId('order-heading')).toHaveText(/order confirmed/i, {
      timeout: 10_000,
    })
    expect(orderNumberOf(page)).toBe(orderNumber)
  })

  // Kills: a 409 that names the order and carries no key, so the resubmit lands on a not-found page.
  test('AC-10: Place Order, Back, and Place Order again lands on /order/<n>?key=<k2> with the same n, showing n; the first key and k2 each read the order', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const buyer = email('ac10')
    const first = await placeAsGuest(page, request, token, buyer)
    const firstKey = orderKeyOf(page)

    await page.goBack({ waitUntil: 'load' })
    await page.waitForURL(/\/checkout/, { timeout: 10_000 })
    await expect(page.getByTestId('contact-email'), 'Back lands on the checkout form').toBeVisible({
      timeout: 15_000,
    })
    await walkToPayment(page, buyer)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })

    expect(orderNumberOf(page)).toBe(first)
    const secondKey = orderKeyOf(page)
    expect(secondKey).toMatch(ORDER_KEY)
    await expect(page.getByTestId('order-number')).toHaveText(first, { timeout: 15_000 })
    for (const key of [firstKey, secondKey]) {
      const res = await apiOrder(request, first, key)
      expect(res.status(), `GET /api/orders/${first} with a key it was answered`).toBe(200)
      expect(((await res.json()) as { data: ApiOrder }).data.orderNumber).toBe(first)
    }
  })

  // Kills: an order page on the default referrer policy, whose same-origin requests (the navigation, its fetches, its
  // subresources) carry the full URL, key included, to the next page.
  test('AC-11: no request the browser issues from the load of /order/<n>?key=<k> until Continue Shopping lands on /products carries k in its Referer, and requests follow the click', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const orderNumber = await placeAsGuest(page, request, token, email('ac11'))
    const key = orderKeyOf(page)

    // `next dev`'s overlay loads its own font from an inline style, which Chromium sends with the page's URL as its
    // Referer whatever the page's referrer policy; production serves no overlay, so the font is no request of the store.
    const devOverlay = (url: string) => new URL(url).pathname.startsWith('/__nextjs_font/')
    const seen: Array<{ url: string; referer: string }> = []
    page.on('request', (r) => {
      if (!devOverlay(r.url())) seen.push({ url: r.url(), referer: r.headers()['referer'] ?? '' })
    })
    await page.goto(keyedOrderPath(orderNumber, key))
    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    await page.waitForLoadState('load')
    const atClick = seen.length

    await page.getByRole('link', { name: /continue shopping/i }).click()
    await page.waitForURL((url) => url.pathname === '/products', { timeout: 15_000 })
    await page.waitForLoadState('load')

    expect(seen.length, 'requests after the click').toBeGreaterThan(atClick)
    expect(
      seen.filter((r) => r.referer.includes(key)).map((r) => `${r.url} (Referer ${r.referer})`),
    ).toEqual([])
  })
})
