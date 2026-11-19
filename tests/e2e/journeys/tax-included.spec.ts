import { randomUUID } from 'node:crypto'
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

// checkout.tax-included-shown, on every storefront project. The custom store (astro-custom, nextjs-custom) has prices
// that include tax, at 20% to a GB address; the native store has no rates. The shopper's order page shows what the
// API recorded: on the custom store an included tax above 0, extracted from each line; on the native store no tax.
// Either way the order's total is the total the checkout showed at submit.

interface OrderRead {
  totalMinor: number
  taxTotalMinor: number
  pricesIncludeTax?: boolean
  lineItems: Array<{ lineTotalMinor: number; lineDiscountMinor?: number }>
}

const gbp = (minor: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)

/** Σ over the order's lines of the tax a 20% rate holds in each: amount − round(amount / 1.2). */
const includedAt20 = (order: OrderRead): number =>
  order.lineItems.reduce((sum, line) => {
    const amount = line.lineTotalMinor - (line.lineDiscountMinor ?? 0)
    return sum + amount - Math.round(amount / 1.2)
  }, 0)

test.describe('An order whose prices include tax says so', () => {
  // Kills: the inclusive flag or the tax not reaching the shopper's order page; a custom store that taxes nothing; a
  // shopper paying other than the total they were shown.
  test('AC-22: checkout.tax-included-shown: an order to a GB address shows its tax on /order/<n>?key=<k> as the API recorded it, labelled "Tax (included)" and Σ amount − round(amount / 1.2) above 0 on the store whose prices include 20% tax, "Tax" and 0 on the store with no rates, and the total the checkout showed at submit @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    const inclusive = isCustomProject(testInfo.project.name)
    const product = await ownProduct(request, await adminToken(request), 5)

    await openCheckout(page, product)
    await walkToPayment(page, `e2e-tax-${randomUUID().slice(0, 8)}@e2e.test`)
    const shownTotal = (
      await page.getByTestId('checkout-summary').locator('[part~="total"]').innerText()
    ).replace(/^Total\s*/, '')
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })

    const res = await page.request.get(`${API_URL}/api/orders/${orderNumberOf(page)}`, {
      headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
    })
    expect(res.status()).toBe(200)
    const order = ((await res.json()) as { data: OrderRead }).data

    expect({
      pricesIncludeTax: order.pricesIncludeTax,
      taxAbove0: order.taxTotalMinor > 0,
      tax: order.taxTotalMinor,
    }).toEqual({
      pricesIncludeTax: inclusive,
      taxAbove0: inclusive,
      tax: inclusive ? includedAt20(order) : 0,
    })
    expect(gbp(order.totalMinor)).toBe(shownTotal)

    const summary = page.getByTestId('order-summary')
    await expect(summary.locator('[part~="tax"] dt')).toHaveText(
      inclusive ? 'Tax (included)' : 'Tax',
      {
        timeout: 15_000,
      },
    )
    await expect(summary.locator('[part~="tax"] dd')).toHaveText(gbp(order.taxTotalMinor))
    await expect(summary.locator('[part~="total"]')).toContainText(shownTotal)
  })
})
