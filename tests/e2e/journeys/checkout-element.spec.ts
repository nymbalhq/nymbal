import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { API_URL } from '../support/csrf'
import {
  adminToken,
  openCheckout,
  orderNumberOf,
  ordersFor,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { expect, test } from '../support/fixtures'

// P2-16 AC-5 and AC-6 on both templates: /checkout is `nymbal-checkout`, with the payment element as its light-DOM
// child. AC-5 is store end state checkout.billing-differs: a billing address that differs from shipping in every field
// reaches the order as entered (Astro's script read it with `new FormData` on a div, which throws, and either template
// could send shipping as billing). AC-6 is the double click: on contact-continue, then on shipping-continue, it
// advances one step each and places nothing: the next step renders under the cursor, so the second click lands on its
// button (the release QA of 2026-10-20 inferred that it placed the order on Astro; the template's `e.detail > 1` guard
// stops it at 606e5aa, and the element must carry the guard).
// Each test buys a product of its own, and the order is read back through the admin API.

const FIELDS = [
  'firstName',
  'lastName',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
] as const
type Field = (typeof FIELDS)[number]
type Address = Partial<Record<Field, string>>

/** What `walkToPayment` types as the shipping address (it leaves the second line empty). */
const SHIPPING: Address = {
  firstName: 'Journey',
  lastName: 'Shopper',
  addressLine1: '12 Checkout Row',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
}

/** Differs from SHIPPING in every field. */
const BILLING: Required<Address> = {
  firstName: 'Ada',
  lastName: 'Byron',
  addressLine1: '7 Ledger Lane',
  addressLine2: 'Suite 4',
  city: 'Bristol',
  region: 'Avon',
  postalCode: 'BS1 5TR',
  country: 'IE',
}

const email = (tag: string) => `e2e-p2-16-${tag}-${randomUUID().slice(0, 8)}@e2e.test`

/** An address as the API holds it, the eight fields the shopper types, an empty one as absent. */
function typed(address: Record<string, unknown>): Address {
  return Object.fromEntries(
    FIELDS.flatMap((field) => {
      const value = address[field]
      return typeof value === 'string' && value !== '' ? [[field, value]] : []
    }),
  )
}

/** Every POST /api/checkout the page sends, from now on. */
function checkoutPosts(page: Page): string[] {
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/checkout') {
      posts.push(request.url())
    }
  })
  return posts
}

test.describe('Checkout is an element', () => {
  // Kills: billing read from markup that throws (Astro today), billing sent as the shipping address.
  test('AC-5: checkout.billing-differs: with billing-same unchecked and a billing address that differs in every field, the order holds that billingAddress and the shipping address apart, the page lands on /order/<n> and the cart is empty', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    await openCheckout(page, product)
    await walkToPayment(page, email('billing'))
    await page.getByTestId('billing-same').uncheck({ timeout: 10_000 })
    for (const field of FIELDS) {
      await page.getByTestId(`billing-${field}`).fill(BILLING[field], { timeout: 10_000 })
    }
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    const res = await request.get(`${API_URL}/api/admin/orders/${orderNumber}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.ok(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(true)
    const order = (
      (await res.json()) as {
        data: { billingAddress: Record<string, unknown>; shippingAddress: Record<string, unknown> }
      }
    ).data
    const billing = typed(order.billingAddress)
    const shipping = typed(order.shippingAddress)
    expect(billing).toEqual(BILLING)
    expect(shipping).toEqual(SHIPPING)
    for (const field of FIELDS) {
      expect(billing[field], `billing ${field} is not the shipping one`).not.toBe(shipping[field])
    }

    const cart = await page.request.get(`${API_URL}/api/cart`)
    expect(((await cart.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(0)
  })

  // Kills: a checkout still rendered from template markup, a payment element moved into the shadow root (or not
  // slotted), where Stripe's card would not share the document tree.
  test('AC-6: on /checkout, contact-email and place-order are inside nymbal-checkout’s shadow root, and nymbal-payment-element is its light-DOM child, slotted into it', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    await openCheckout(page, product)
    await expect(page.getByTestId('contact-email')).toBeVisible({ timeout: 15_000 })
    const where = await page.evaluate(() => {
      const checkout = document.querySelector('nymbal-checkout')
      const root = checkout?.shadowRoot ?? null
      const pay = document.querySelector('nymbal-payment-element')
      return {
        contactEmailInShadow: root?.querySelector('[data-testid="contact-email"]') != null,
        placeOrderInShadow: root?.querySelector('[data-testid="place-order"]') != null,
        placeOrderInLightDom: document.querySelector('[data-testid="place-order"]') != null,
        paymentIsLightChild: checkout != null && pay?.parentElement === checkout,
        paymentSlottedIntoCheckout:
          root !== null && pay?.assignedSlot != null && pay.assignedSlot.getRootNode() === root,
      }
    })
    expect(where).toEqual({
      contactEmailInShadow: true,
      placeOrderInShadow: true,
      placeOrderInLightDom: false,
      paymentIsLightChild: true,
      paymentSlottedIntoCheckout: true,
    })
  })

  // Kills: the second click of a double click on Continue submitting the next step's button, rendered under it.
  test('AC-6: a double click on contact-continue, then on shipping-continue, shows the payment step and creates no order; one click on place-order then places exactly one', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const buyer = email('dblclick')
    const before = await ordersFor(request, token, buyer)

    await openCheckout(page, product)
    const posts = checkoutPosts(page)
    // The buttons double-clicked are the element's: the same clicks on template markup prove nothing about it.
    const checkout = page.locator('nymbal-checkout')
    await checkout.getByTestId('contact-email').fill(buyer, { timeout: 15_000 })
    await checkout.getByTestId('contact-continue').dblclick()
    await expect(checkout.getByTestId('shipping-firstName')).toBeVisible({ timeout: 10_000 })
    await expect(checkout.getByTestId('place-order'), 'one step, not two').toBeHidden()

    await checkout.getByTestId('shipping-firstName').fill(SHIPPING.firstName!)
    await checkout.getByTestId('shipping-lastName').fill(SHIPPING.lastName!)
    await checkout.getByTestId('shipping-addressLine1').fill(SHIPPING.addressLine1!)
    await checkout.getByTestId('shipping-city').fill(SHIPPING.city!)
    await checkout.getByTestId('shipping-region').fill(SHIPPING.region!)
    await checkout.getByTestId('shipping-postalCode').fill(SHIPPING.postalCode!)
    await checkout.getByTestId('shipping-country').fill(SHIPPING.country!)
    await checkout.getByTestId('shipping-continue').dblclick()
    await page.waitForLoadState('networkidle')

    expect(posts, 'POST /api/checkout from the double clicks').toEqual([])
    expect(await ordersFor(request, token, buyer)).toEqual(before)
    expect(new URL(page.url()).pathname).toBe('/checkout')
    await expect(checkout.getByTestId('place-order')).toBeVisible()
    await expect(checkout.getByTestId('place-order')).toBeEnabled({ timeout: 10_000 })

    await checkout.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    expect(posts).toHaveLength(1)
    const orders = await ordersFor(request, token, buyer)
    expect(orders.map((o) => o.orderNumber)).toEqual([orderNumberOf(page)])
    expect(orders.length).toBe(before.length + 1)
  })

  // Kills: a step change that shortens the page under a still cursor, so a double click's second click lands outside
  // the element (Next's footer: /account/register), where its multi-click guards cannot see it. Each size is double
  // clicked twice over: as Playwright does, and as a person does, the second click once the payment step is shown.
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    for (const hand of ['dblclick', 'person'] as const) {
      test(`diff review B1: at ${viewport.width}x${viewport.height}, a double click (${hand}) on shipping-continue leaves the page on /checkout with place-order shown, sends no POST /api/checkout and creates no order`, async ({
        page,
        request,
      }) => {
        test.setTimeout(90_000)
        await page.setViewportSize(viewport)
        const token = await adminToken(request)
        const product = await ownProduct(request, token, 5)
        const buyer = email('b1')
        const before = await ordersFor(request, token, buyer)

        await openCheckout(page, product)
        const posts = checkoutPosts(page)
        const checkout = page.locator('nymbal-checkout')
        await checkout.getByTestId('contact-email').fill(buyer, { timeout: 15_000 })
        await checkout.getByTestId('contact-continue').click()
        for (const field of FIELDS) {
          const value = SHIPPING[field]
          if (value !== undefined) await checkout.getByTestId(`shipping-${field}`).fill(value)
        }
        const cont = checkout.getByTestId('shipping-continue')
        if (hand === 'dblclick') {
          await cont.dblclick()
        } else {
          await cont.scrollIntoViewIfNeeded()
          const box = await cont.boundingBox()
          expect(box, 'shipping-continue is laid out').not.toBeNull()
          await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
          await page.mouse.down({ clickCount: 1 })
          await page.mouse.up({ clickCount: 1 })
          // A person's second click comes after the payment step has rendered and settled, not in its frame.
          await expect(checkout.getByTestId('place-order')).toBeVisible()
          await page.mouse.down({ clickCount: 2 })
          await page.mouse.up({ clickCount: 2 })
        }
        await page.waitForLoadState('networkidle')

        expect(new URL(page.url()).pathname).toBe('/checkout')
        await expect(checkout.getByTestId('place-order')).toBeVisible()
        expect(posts, 'POST /api/checkout from the double click').toEqual([])
        expect(await ordersFor(request, token, buyer)).toEqual(before)
      })
    }
  }
})
