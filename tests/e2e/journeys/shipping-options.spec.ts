import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { isCustomProject } from '../support/capabilities'
import {
  adminToken,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// checkout.shipping-option-charged, on every storefront project. The custom store (astro-custom, nextjs-custom) ships
// Standard free and Express at £4.99, and its prices include 20% tax to a GB address, shipping included; the native
// store sets no shipping table, so its one option is a free Standard. What the summary shows for the option chosen is
// what the order records and charges.

interface OrderRead {
  totalMinor: number
  shippingTotalMinor: number
  taxTotalMinor: number
  lineItems: Array<{ lineTotalMinor: number; lineDiscountMinor?: number }>
}

const EXPRESS_MINOR = 499

const gbp = (minor: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)

/** The tax a 20% rate holds in an amount that includes it: amount − round(amount / 1.2). */
const within20 = (amount: number): number => amount - Math.round(amount / 1.2)

/** The money in a piece of text, as the summary formats it: £1,234.56. */
const moneyIn = (text: string): number => {
  const match = /£([\d,]+)\.(\d\d)/.exec(text)
  if (match === null) throw new Error(`no amount in "${text}"`)
  return Number(match[1]!.replace(/,/g, '')) * 100 + Number(match[2])
}

/** The radio of one delivery option, whether its test id sits on the radio or on what wraps it. */
const radioOf = (page: Page, id: string): Locator =>
  page.locator(
    `input[data-testid="checkout-shipping-option-${id}"], [data-testid="checkout-shipping-option-${id}"] input`,
  )

test.describe('The delivery the shopper chooses is what the order charges', () => {
  // Kills: an element that never sends the shown total (the order refused), shipping not charged or not taxed, or a
  // shopper paying other than the total the summary showed.
  test('AC-25: checkout.shipping-option-charged: on the custom store the payment step offers Standard (checked, the total the cart’s) and Express; choosing Express shows £4.99 shipping, the included tax of the lines and of the shipping, and a total £4.99 above; the order the API returns and its page charge exactly that; on the native store the one option is a free Standard and the total is the subtotal @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const custom = isCustomProject(testInfo.project.name)
    const product = await ownProduct(request, await adminToken(request), 5)

    await openCheckout(page, product)
    await walkToPayment(page, `e2e-ship-${randomUUID().slice(0, 8)}@e2e.test`)
    const summary = page.getByTestId('checkout-summary')
    const total = summary.locator('[part~="total"]')
    const options = page.locator('[data-testid^="checkout-shipping-option-"]')
    const subtotal = moneyIn(await summary.getByTestId('cart-subtotal').innerText())

    if (!custom) {
      await expect(options).toHaveCount(1)
      await expect(options.first()).toHaveAttribute(
        'data-testid',
        'checkout-shipping-option-standard',
      )
      await expect(page.getByTestId('checkout-payment')).toContainText('Standard')
      await expect(page.getByTestId('checkout-payment')).toContainText('Free')
      await expect(radioOf(page, 'standard')).toBeChecked()
      await expect(total).toContainText(gbp(subtotal))
      return
    }

    await expect(options).toHaveCount(2)
    await expect(radioOf(page, 'standard')).toBeChecked()
    await expect(radioOf(page, 'express')).not.toBeChecked()
    const cartTotal = moneyIn(await total.innerText())
    expect(cartTotal).toBe(subtotal)

    await radioOf(page, 'express').check()
    await expect(total).toContainText(gbp(cartTotal + EXPRESS_MINOR), { timeout: 10_000 })
    await expect(page.getByTestId('place-order')).toBeEnabled()
    await expect(summary.getByTestId('checkout-summary-shipping')).toContainText(gbp(EXPRESS_MINOR))
    await expect(summary).toContainText('Tax (included)')
    const shownTax = moneyIn(await summary.getByTestId('checkout-summary-tax').innerText())
    const shownTotal = moneyIn(await total.innerText())

    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\/[^/?#]+\?key=/, { timeout: 20_000 })
    const res = await page.request.get(`${API_URL}/api/orders/${orderNumberOf(page)}`, {
      headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
    })
    expect(res.status()).toBe(200)
    const order = ((await res.json()) as { data: OrderRead }).data
    const linesTax = order.lineItems.reduce(
      (sum, line) => sum + within20(line.lineTotalMinor - (line.lineDiscountMinor ?? 0)),
      0,
    )

    expect({
      shipping: order.shippingTotalMinor,
      tax: order.taxTotalMinor,
      total: order.totalMinor,
    }).toEqual({ shipping: EXPRESS_MINOR, tax: shownTax, total: shownTotal })
    expect(shownTax).toBe(linesTax + within20(EXPRESS_MINOR))
    expect(shownTotal).toBe(cartTotal + EXPRESS_MINOR)
    await expect(page.getByTestId('order-summary').locator('[part~="shipping"] dd')).toHaveText(
      gbp(EXPRESS_MINOR),
      { timeout: 15_000 },
    )
  })
})
