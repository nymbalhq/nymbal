import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct, type OwnProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'

// A refund names the product it is for: the refund dialog offers the order's lines, the payment panel says which
// product each refund was for, and the admin API carries the same line. The order is placed through the storefront
// API with two products of the journey's own; the stub pays it inline.

const address = {
  firstName: 'Avery',
  lastName: 'Quinn',
  addressLine1: '42 Harbour Lane',
  city: 'Bristol',
  region: 'Bristol',
  postalCode: 'BS1 4DJ',
  country: 'GB',
}

interface OrderRead {
  orderNumber: string
  lineItems: Array<{ variantId: string; productName: string; variantName: string }>
  payment: {
    state: string
    capturedMinor: number
    refundedMinor: number
    currency: string
    refunds: Array<{ id: string; amountMinor: number; status: string; variantId: string | null }>
  }
}

/** A paid order of one unit of each of two products of its own, placed as a guest. */
async function placeTwoProductOrder(
  request: APIRequestContext,
): Promise<{ orderNumber: string; products: [OwnProduct, OwnProduct] }> {
  // The admin signs in on a context of its own, so the shopper's checkout below stays a guest's.
  const admin = await playwrightRequest.newContext()
  let products: [OwnProduct, OwnProduct]
  try {
    const token = await adminToken(admin)
    products = [await ownProduct(admin, token, 2), await ownProduct(admin, token, 2)]
  } finally {
    await admin.dispose()
  }
  for (const product of products) {
    const added = await request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(request, API_URL),
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
  }
  const checkout = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request, API_URL),
    data: {
      email: `e2e-refund-line-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
      billingAddress: address,
      shippingAddress: address,
    },
  })
  expect(checkout.ok(), `POST /api/checkout: ${await checkout.text()}`).toBe(true)
  const { orderNumber } = ((await checkout.json()) as { data: { orderNumber: string } }).data
  return { orderNumber, products }
}

async function readOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<OrderRead> {
  const res = await request.get(`${API_URL}/api/admin/orders/${orderNumber}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/orders/${orderNumber}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: OrderRead }).data
}

/** The amount as the admin formats it (`apps/admin/src/lib/money.ts`). */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

const REFUND_POST = /\/api\/admin\/orders\/[^/]+\/refund$/

/** Counts the page's refund POSTs from here on; `settled()` waits until every one sent has been answered. */
function watchRefundPosts(page: Page): { settled(): Promise<void> } {
  let sent = 0
  let answered = 0
  const isRefund = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && REFUND_POST.test(new URL(r.url()).pathname)
  const onSent = (r: { method(): string; url(): string }) => {
    if (isRefund(r)) sent += 1
  }
  const onAnswered = (r: { method(): string; url(): string }) => {
    if (isRefund(r)) answered += 1
  }
  page.on('request', onSent)
  page.on('requestfinished', onAnswered)
  page.on('requestfailed', onAnswered)
  return {
    async settled() {
      await expect.poll(() => sent - answered, { message: 'refund POSTs still in flight' }).toBe(0)
      page.off('request', onSent)
      page.off('requestfinished', onAnswered)
      page.off('requestfailed', onAnswered)
    },
  }
}

/** Picks a choice of the dialog's Product select, a native select or the admin's Radix one. */
async function chooseLine(page: Page, label: string): Promise<void> {
  const select = page.getByTestId('admin-order-refund-line')
  if ((await select.evaluate((el) => el.tagName)) === 'SELECT') {
    await select.selectOption({ label })
    return
  }
  await select.click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

async function refundThroughDialog(
  page: Page,
  amountMinor: number,
  line: string,
  confirm: 'click' | 'dblclick' = 'click',
): Promise<void> {
  const posts = watchRefundPosts(page)
  await page.getByTestId('admin-order-actions').click()
  await page.getByTestId('admin-order-action-refund').click()
  const dialog = page.getByTestId('admin-order-refund-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('admin-order-refund-amount').fill((amountMinor / 100).toFixed(2))
  await chooseLine(page, line)
  await page.getByTestId('admin-order-refund-confirm')[confirm]()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await posts.settled()
}

test.describe('Admin refunds name their product', () => {
  // Kills: a page that shows a product the API does not carry, a double click that refunds twice, and a refund made
  // "Not for one product" shown or stored with a product.
  test('AC-7: on a paid two-product order, a partial refund for the second product confirmed with a double click makes one refund whose row says "for" that product and whose API refund carries its variantId; a second refund "Not for one product" shows no product and answers variantId null', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeTwoProductOrder(request)
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    expect(start.payment.state).toBe('paid')
    const second = start.lineItems.find((l) => l.variantId === order.products[1].variantId)!
    expect(second.productName).toBe(order.products[1].name)
    const part = Math.max(1, Math.floor(start.payment.capturedMinor / 4))
    const currency = start.payment.currency

    await signInAsAdmin(page)
    await page.goto(`orders/${order.orderNumber}`)
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })

    await refundThroughDialog(
      page,
      part,
      `${second.productName} · ${second.variantName}`,
      'dblclick',
    )

    const afterFirst = await readOrder(request, token, order.orderNumber)
    expect(afterFirst.payment.refunds.map((r) => [r.amountMinor, r.variantId])).toEqual([
      [part, second.variantId],
    ])
    expect(afterFirst.payment.refundedMinor).toBe(start.payment.refundedMinor + part)
    const firstId = afterFirst.payment.refunds[0]!.id
    await expect(page.getByTestId(`admin-order-refund-row-line-${firstId}`)).toContainText(
      `for ${second.productName}`,
    )

    await refundThroughDialog(page, part, 'Not for one product')

    const afterSecond = await readOrder(request, token, order.orderNumber)
    const later = afterSecond.payment.refunds.filter((r) => r.id !== firstId)
    expect(later.map((r) => [r.amountMinor, r.variantId])).toEqual([[part, null]])
    await expect(page.getByTestId(`admin-order-refund-row-${later[0]!.id}`)).toContainText(
      money(part, currency),
    )
    await expect(page.getByTestId(`admin-order-refund-row-line-${later[0]!.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`admin-order-refund-row-line-${firstId}`)).toContainText(
      `for ${second.productName}`,
    )
  })
})
