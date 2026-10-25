import { randomUUID } from 'node:crypto'
import { isCustomProject, storeCapabilities } from '../support/capabilities'
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

// AC-5 (the swap) and AC-2's journey half, on every storefront project: astro and nextjs against the native store on
// 3001, astro-custom and nextjs-custom against the custom-providers fixture store on 3011. The same file on both
// configs: what it expects of the payment step is read from GET /api/capabilities, never from the project.

const email = (tag: string) => `e2e-caps-${tag}-${randomUUID().slice(0, 8)}@e2e.test`

test.describe('The payment step follows the payments adapter', () => {
  test('AC-5: the run reaches the store its project names: the custom runs report search without facet and no payments client, the native runs facet and test-mode, and the storefront calls that same API @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    const custom = isCustomProject(testInfo.project.name)
    const caps = await storeCapabilities(request)

    expect(caps.search.capabilities.includes('facet'), JSON.stringify(caps.search)).toBe(!custom)
    expect(caps.payments.client === null, JSON.stringify(caps.payments)).toBe(custom)
    expect(caps.payments.client?.driver ?? null).toBe(custom ? null : 'test-mode')

    // The storefront's own browser calls go to the API the journeys read, not to another store.
    const listed = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/products')
    await page.goto('/products')
    expect(new URL((await listed).url()).origin).toBe(new URL(API_URL).origin)
  })

  test('AC-5: checkout renders the payment UI the store’s client half names (none for a null client), completes, and the API holds the order confirmed @capabilities', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const caps = await storeCapabilities(request)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    await openCheckout(page, product)
    await walkToPayment(page, email('pay'))

    const element = page.getByTestId('payment-element')
    await expect(element).toHaveCount(1)
    await expect(element).toHaveText(
      caps.payments.client === null ? '' : /Test mode — payment skipped/,
    )
    await expect(page.getByTestId('payment-element-error')).toHaveCount(0)
    // No vendor element survives on either template.
    await expect(
      page.locator('[data-testid="stripe-card-element"], [data-testid="card-element"]'),
    ).toHaveCount(0)

    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/order\//, { timeout: 20_000 })
    const orderNumber = orderNumberOf(page)

    const order = await page.request.get(`${API_URL}/api/orders/${orderNumber}`, {
      headers: { [ORDER_KEY_HEADER]: orderKeyOf(page) },
    })
    expect(order.status()).toBe(200)
    expect(((await order.json()) as { data: { status: string } }).data.status).toBe('confirmed')
    await expect(page.getByTestId('order-status')).toHaveText(/confirmed/i, { timeout: 15_000 })
  })
})
