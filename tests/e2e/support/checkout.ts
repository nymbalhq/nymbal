import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './admin'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'

// Helpers for the checkout journeys on both templates: a product of the test's own (so parallel projects and other
// journeys never move its stock), the shopper's walk to Place Order, and the API's view of what the walk did.

export interface OwnProduct {
  slug: string
  variantId: string
  name: string
}

export async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/api/auth/login`, {
    headers: await csrf(request),
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  expect(res.ok(), `admin API login: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken
}

/** An active product with one variant at `stock`, served by the read side before this returns. */
export async function ownProduct(
  request: APIRequestContext,
  token: string,
  stock: number,
): Promise<OwnProduct> {
  const tag = randomUUID().slice(0, 8)
  const name = `Checkout Journey ${tag}`
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug: `checkout-${tag}`,
      name,
      description: 'A product of one checkout journey.',
      status: 'active',
      variants: [{ sku: `P112-${tag}`, name: 'Default', priceMinor: 1999, stock, options: [] }],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  const body = (await res.json()) as { data: { slug: string; variants: Array<{ id: string }> } }
  const product = { slug: body.data.slug, variantId: body.data.variants[0]!.id, name }
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${product.slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return product
}

/**
 * A registered shopper with one order of a product of its own, through the API. The email is 34 characters with an
 * unbroken local part, so a page that shows it cannot wrap it to fit a phone (a 28-character one already ran past the
 * viewport on the account dashboard).
 */
export async function shopperWithOrder(
  request: APIRequestContext,
  password: string,
): Promise<{
  email: string
  firstName: string
  orderNumber: string
  customerId: string
  product: OwnProduct
}> {
  const product = await ownProduct(request, await adminToken(request), 5)
  const tag = randomUUID().slice(0, 8)
  const email = `phonewidthshopper${tag}@e2e.test`
  const firstName = `Ada${tag}`
  const shopper = await playwrightRequest.newContext()
  try {
    const reg = await shopper.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(shopper),
      data: { email, password, firstName, lastName: 'Phonewidth' },
    })
    expect(reg.ok(), `POST /api/auth/register: ${await reg.text()}`).toBe(true)
    const { accessToken, customer } = (
      (await reg.json()) as { data: { accessToken: string; customer: { id: string } } }
    ).data
    const auth = { authorization: `Bearer ${accessToken}` }
    const add = await shopper.post(`${API_URL}/api/cart/items`, {
      headers: { ...(await csrf(shopper)), ...auth },
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(add.ok(), `POST /api/cart/items: ${await add.text()}`).toBe(true)
    const address = {
      firstName,
      lastName: 'Phonewidth',
      addressLine1: '7 Narrow Street',
      city: 'Bristol',
      region: 'Avon',
      postalCode: 'BS1 5TT',
      country: 'GB',
    }
    const checkout = await shopper.post(`${API_URL}/api/checkout`, {
      headers: { ...(await csrf(shopper)), ...auth },
      data: { email, billingAddress: address, shippingAddress: address },
    })
    expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
    const { orderNumber } = ((await checkout.json()) as { data: { orderNumber: string } }).data
    return { email, firstName, orderNumber, customerId: customer.id, product }
  } finally {
    await shopper.dispose()
  }
}

/** The variant's stock as the storefront API serves it. */
export async function servedStock(
  request: APIRequestContext,
  product: OwnProduct,
): Promise<number> {
  const res = await request.get(`${API_URL}/api/products/${product.slug}`)
  const body = (await res.json()) as { data: { variants: Array<{ id: string; stock: number }> } }
  return body.data.variants.find((v) => v.id === product.variantId)!.stock
}

/** Every order placed with exactly this email, from the admin API. */
export async function ordersFor(
  request: APIRequestContext,
  token: string,
  email: string,
): Promise<Array<{ orderNumber: string; status: string }>> {
  const res = await request.get(
    `${API_URL}/api/admin/orders?customer=${encodeURIComponent(email)}&limit=200`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  expect(res.ok(), `GET /api/admin/orders: ${await res.text()}`).toBe(true)
  const body = (await res.json()) as {
    data: Array<{ orderNumber: string; status: string; email: string }>
  }
  return body.data.filter((o) => o.email.toLowerCase() === email.toLowerCase())
}

/**
 * Product page, Add to Cart (one unit), the cart's Checkout. Waits for the checkout page's `load`: its script (Astro's module, Next's
 * hydration) attaches the forms' submit handlers before then, and a Continue clicked earlier submits the form natively,
 * reloading the page at the contact step.
 */
export async function openCheckout(page: Page, product: OwnProduct): Promise<void> {
  await page.goto(`/product/${product.slug}`)
  await expect(page.getByTestId('add-to-cart')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('add-to-cart').click()
  await page.getByTestId('cart-checkout-btn').click({ timeout: 10_000 })
  await page.waitForURL(/\/checkout/, { timeout: 10_000 })
  await page.waitForLoadState('load')
}

/** Contact and shipping, up to a visible Place Order. */
export async function walkToPayment(page: Page, email: string): Promise<void> {
  await page.getByTestId('contact-email').fill(email)
  await page.getByTestId('contact-continue').click()
  await page.getByTestId('shipping-firstName').fill('Journey')
  await page.getByTestId('shipping-lastName').fill('Shopper')
  await page.getByTestId('shipping-addressLine1').fill('12 Checkout Row')
  await page.getByTestId('shipping-city').fill('Leeds')
  await page.getByTestId('shipping-region').fill('West Yorkshire')
  await page.getByTestId('shipping-postalCode').fill('LS1 4AP')
  await page.getByTestId('shipping-country').fill('GB')
  await page.getByTestId('shipping-continue').click()
  await expect(page.getByTestId('place-order')).toBeEnabled({ timeout: 10_000 })
}

/** The order number of the `/order/<n>` page the browser is on. */
export function orderNumberOf(page: Page): string {
  const match = /\/order\/([^/?#]+)/.exec(new URL(page.url()).pathname)
  if (match === null) throw new Error(`not on an order page: ${page.url()}`)
  return decodeURIComponent(match[1]!)
}

/** The request header an order's key goes to the API in. */
export const ORDER_KEY_HEADER = 'x-nymbal-order-key'

/**
 * The key of the `/order/<n>?key=<k>` page the browser is on: what the confirmation URL and the order email's link
 * carry, and what reads the order from the API in `x-nymbal-order-key`.
 */
export function orderKeyOf(page: Page): string {
  const key = new URL(page.url()).searchParams.get('key')
  if (key === null || key === '') throw new Error(`no ?key= on the order page: ${page.url()}`)
  return key
}

/** The order page's URL with its key, as the confirmation redirect and the email link give it. */
export function keyedOrderPath(orderNumber: string, key: string): string {
  return `/order/${encodeURIComponent(orderNumber)}?key=${encodeURIComponent(key)}`
}

/**
 * Flags, in `window`, any moment the page (its title, its body or any shadow root in it) says "Order confirmed", even
 * briefly. A document `MutationObserver` never sees a mutation inside a shadow tree, and the body's `textContent`
 * leaves shadow-root text out, so every root `attachShadow` creates is observed and read too.
 */
export async function watchConfirmedClaim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __nymbalSaidConfirmed?: boolean }
    const roots: ShadowRoot[] = []
    const check = () => {
      const shown = [document.title, document.body?.textContent ?? '']
        .concat(roots.map((root) => root.textContent ?? ''))
        .join(' ')
      if (/order confirmed/i.test(shown)) w.__nymbalSaidConfirmed = true
    }
    const watch = (target: Node) =>
      new MutationObserver(check).observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    const attachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attachShadow.call(this, init)
      roots.push(root)
      watch(root)
      return root
    }
    watch(document)
  })
}

export async function saidConfirmed(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __nymbalSaidConfirmed?: boolean }).__nymbalSaidConfirmed === true,
  )
}
