import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './admin'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'

// P1-12 helpers for the checkout journeys on both templates: a product of the test's own (so parallel projects and
// other journeys never move its stock), the shopper's walk to Place Order, and the API's view of what the walk did.

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
      slug: `p1-12-${tag}`,
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

/**
 * Flags, in `window`, any moment the page (its title, its body or any shadow root in it) says "Order confirmed", even
 * briefly. A document `MutationObserver` never sees a mutation inside a shadow tree, and the body's `textContent`
 * leaves shadow-root text out (P2-16 Decision 8), so every root `attachShadow` creates is observed and read too.
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
