import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { csrf } from '../../support/csrf'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct } from '../../support/checkout'
import { postSignedWebhook } from '../../support/webhooks'

const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
const ADMIN_EMAIL = process.env.NYMBAL_ADMIN_EMAIL ?? 'admin@nymbal.local'
const ADMIN_PASSWORD = process.env.NYMBAL_ADMIN_PASSWORD ?? 'nymbal-admin-dev'

// Canonical Address shape from @nymbalhq/types (firstName/lastName/addressLine1/region).
const address = {
  firstName: 'Avery',
  lastName: 'Quinn',
  addressLine1: '42 Harbour Lane',
  city: 'Bristol',
  region: 'Bristol',
  postalCode: 'BS1 4DJ',
  country: 'GB',
}

/**
 * Places a real order through the platform API: a product of its own → cart →
 * checkout (native-stub payments). The product is the order's own, so this never
 * moves the stock of a product another journey asserts on. The default
 * `+stub-pending` email leaves the order pending for the admin to confirm; any
 * other email is captured by the stub. Every response is wrapped in the
 * { data, meta, error } envelope and must be unwrapped.
 */
async function placeOwnOrder(
  request: APIRequestContext,
  email = `e2e-admin-orders-${Date.now()}-${Math.floor(Math.random() * 1e6)}+stub-pending@nymbal.dev`,
): Promise<{ orderId: string; orderNumber: string }> {
  // The admin signs in on a context of its own, so the shopper's checkout below stays a guest's.
  const admin = await playwrightRequest.newContext()
  let variantId: string
  try {
    variantId = (await ownProduct(admin, await adminToken(admin), 1)).variantId
  } finally {
    await admin.dispose()
  }

  const addRes = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request, API_URL),
    data: { variantId, qty: 1 },
  })
  expect(addRes.ok(), `POST /api/cart/items: ${await addRes.text()}`).toBe(true)

  const checkoutRes = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request, API_URL),
    data: {
      email,
      billingAddress: address,
      shippingAddress: address,
    },
  })
  expect(checkoutRes.ok(), 'POST /api/checkout should succeed').toBe(true)
  const checkoutBody = (await checkoutRes.json()) as {
    data: { orderId: string; orderNumber: string }
  }
  expect(checkoutBody.data.orderNumber).toMatch(/^(NYM|INT)-/)
  return {
    orderId: checkoutBody.data.orderId,
    orderNumber: checkoutBody.data.orderNumber,
  }
}

// The admin access token is held in memory only, so every full page load
// starts from the login screen.
async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('login')
  await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
  await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
  await page.getByTestId('admin-login-submit').click()
  await expect(page.getByTestId('admin-nav-orders')).toBeVisible({ timeout: 15000 })
}

async function openOrderDetail(page: Page, orderNumber: string): Promise<void> {
  await page.getByTestId('admin-nav-orders').click()
  const row = page.getByTestId(`admin-orders-row-${orderNumber}`)
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.click()
  await expect(page.getByTestId('admin-order-detail')).toBeVisible({ timeout: 15000 })
}

// AC-10 and AC-11: the admin shows what was actually paid and refunded, from the order's stored amounts, and the
// admin API agrees at every step. Orders come from the storefront API (a `+stub-pending` order stays unpaid; any other
// email is paid inline by the stub), each journey its own.

interface PaymentRead {
  state: 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'
  capturedMinor: number
  refundedMinor: number
  refundableMinor: number
  currency: string
  refunds: Array<{ id: string; amountMinor: number; status: string }>
}

interface OrderRead {
  orderNumber: string
  paymentIntentId: string | null
  status: string
  totalMinor: number
  currency: string
  payment: PaymentRead
}

/** The amount as the admin formats it (`apps/admin/src/lib/money.ts`). */
function money(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

/** Text that ends with exactly this amount: no digit before it, so £9.99 never matches £19.99. */
function endsWithAmount(amountMinor: number, currency: string): RegExp {
  const escaped = money(amountMinor, currency).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\d.,])${escaped}\\s*$`)
}

const LABEL: Record<PaymentRead['state'], RegExp> = {
  unpaid: /^\s*Unpaid\s*$/i,
  paid: /^\s*Paid\s*$/i,
  partially_refunded: /^\s*Partially refunded\s*$/i,
  refunded: /^\s*Refunded\s*$/i,
}

/** An email the stub pays inline (no `+stub-pending`), unique to one journey. */
function paidEmail(kind: string): string {
  return `e2e-money-${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`
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

/** The detail page's Payment panel agrees with the admin API's read of the same order. */
async function expectPaymentPanel(page: Page, read: OrderRead): Promise<void> {
  const { payment } = read
  await expect(page.getByTestId('admin-order-payment-state')).toHaveText(LABEL[payment.state], {
    timeout: 15_000,
  })
  await expect(page.getByTestId('admin-order-captured')).toHaveText(
    endsWithAmount(payment.capturedMinor, payment.currency),
  )
  await expect(page.getByTestId('admin-order-refunded')).toHaveText(
    endsWithAmount(payment.refundedMinor, payment.currency),
  )
  await expect(page.getByTestId('admin-order-net')).toHaveText(
    endsWithAmount(payment.capturedMinor - payment.refundedMinor, payment.currency),
  )
}

async function openDetail(page: Page, orderNumber: string): Promise<void> {
  await page.goto(`orders/${orderNumber}`)
  await expect(page.getByTestId('admin-order-detail')).toContainText(orderNumber, {
    timeout: 15_000,
  })
}

const REFUND_POST = /\/api\/admin\/orders\/[^/]+\/refund$/

/**
 * Counts the page's refund POSTs from here on; `settled()` waits until every one sent has been answered, so a read
 * after it sees whatever a second (double-clicked) POST did, whichever way the page or the API keeps it to one refund.
 */
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

/** The refund dialog, by amount only, entered in major units as the admin enters prices. */
async function refundThroughDialog(
  page: Page,
  amountMinor: number,
  confirm: 'click' | 'dblclick' = 'click',
): Promise<void> {
  const posts = watchRefundPosts(page)
  await page.getByTestId('admin-order-actions').click()
  await page.getByTestId('admin-order-action-refund').click()
  const dialog = page.getByTestId('admin-order-refund-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('admin-order-refund-amount').fill((amountMinor / 100).toFixed(2))
  await page.getByTestId('admin-order-refund-reason').fill('Returned by the customer')
  await page.getByTestId('admin-order-refund-confirm')[confirm]()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await posts.settled()
}

test.describe('Admin orders', () => {
  // Kills: "Paid" read from the intent every order has from checkout start, and Captured shown as the order total
  // whatever was paid.
  test('AC-10: a +stub-pending order shows Unpaid with Captured 0 and offers neither a refund nor confirmed; a paid stub order shows Paid with Captured = its total; the list Payment column agrees for both', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const unpaid = await placeOwnOrder(request)
    // A second shopper, with a cart of their own: from the same cart the paid checkout would supersede the pending order.
    const shopper = await playwrightRequest.newContext()
    let paid: Awaited<ReturnType<typeof placeOwnOrder>>
    try {
      paid = await placeOwnOrder(shopper, paidEmail('paid'))
    } finally {
      await shopper.dispose()
    }
    const token = await adminToken(request)
    const unpaidRead = await readOrder(request, token, unpaid.orderNumber)
    const paidRead = await readOrder(request, token, paid.orderNumber)
    expect(unpaidRead.payment?.state).toBe('unpaid')
    expect(unpaidRead.payment?.capturedMinor).toBe(0)
    expect(paidRead.payment?.state).toBe('paid')
    expect(paidRead.payment?.capturedMinor).toBe(paidRead.totalMinor)

    await signInAsAdmin(page)
    await openDetail(page, unpaid.orderNumber)
    await expectPaymentPanel(page, unpaidRead)
    // Each absence is read from the open menu, and Escape waits for the menu to take pointer input: Radix's layer
    // ignores Escape until its post-mount re-render, and a dropped Escape leaves the page under pointer-events: none.
    await page.getByTestId('admin-order-actions').click()
    const actions = page.getByRole('menu', { name: 'Actions' })
    await expect(actions.getByRole('menuitem', { name: 'Cancel order' })).toBeVisible()
    await expect(actions).toHaveCSS('pointer-events', 'auto')
    await expect(page.getByTestId('admin-order-action-refund')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(actions).toBeHidden()
    // A pending order is confirmed by recording a payment, never by the status select (M5).
    await page.getByTestId('admin-order-status-select').click()
    const statuses = page.getByRole('listbox')
    await expect(page.getByTestId('admin-order-status-option-record-payment')).toBeVisible()
    await expect(statuses).toHaveCSS('pointer-events', 'auto')
    await expect(page.getByTestId('admin-order-status-option-confirmed')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(statuses).toBeHidden()

    await openDetail(page, paid.orderNumber)
    await expectPaymentPanel(page, paidRead)
    await expect(page.getByTestId('admin-order-captured')).toHaveText(
      endsWithAmount(paidRead.totalMinor, paidRead.currency),
    )

    await page.goto('orders')
    for (const read of [unpaidRead, paidRead]) {
      await page.getByPlaceholder('Search orders...').fill(read.orderNumber)
      await expect(page.getByTestId(`admin-orders-payment-${read.orderNumber}`)).toHaveText(
        LABEL[read.payment.state],
        { timeout: 15_000 },
      )
    }
  })

  // Kills: a refund that changes only the label (no amount moved or shown), and a page that disagrees with the API.
  test('AC-11: a partial refund shows Partially refunded, Refunded = the amount, Net = captured − refunded and a refund row; refunding the rest shows Refunded with Net 0; GET /api/admin/orders/:n agrees at each step and after a reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeOwnOrder(request, paidEmail('refund'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment?.capturedMinor
    expect(captured).toBe(start.totalMinor)
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part).toBeLessThan(captured)

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await expectPaymentPanel(page, start)

    // A double click on "Refund" refunds once: the dialog's pending guard and its requestId keep the repeat to one
    // refund.
    await refundThroughDialog(page, part, 'dblclick')

    const afterPart = await readOrder(request, token, order.orderNumber)
    expect(afterPart.payment.state).toBe('partially_refunded')
    expect(afterPart.payment.refundedMinor).toBe(part)
    expect(afterPart.payment.capturedMinor).toBe(captured)
    expect(afterPart.payment.refundableMinor).toBe(captured - part)
    expect(afterPart.payment.refunds.map((r) => [r.amountMinor, r.status])).toEqual([
      [part, 'succeeded'],
    ])
    await expectPaymentPanel(page, afterPart)
    await expect(
      page.getByTestId(`admin-order-refund-row-${afterPart.payment.refunds[0]!.id}`),
    ).toContainText(money(part, afterPart.payment.currency))

    await refundThroughDialog(page, captured - part)

    const afterAll = await readOrder(request, token, order.orderNumber)
    expect(afterAll.payment.state).toBe('refunded')
    expect(afterAll.payment.refundedMinor).toBe(captured)
    expect(afterAll.payment.refundableMinor).toBe(0)
    expect(afterAll.status).toBe('confirmed')
    await expectPaymentPanel(page, afterAll)
    await expect(page.getByTestId('admin-order-net')).toHaveText(
      endsWithAmount(0, afterAll.payment.currency),
    )
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Confirmed')
    for (const refund of afterAll.payment.refunds) {
      await expect(page.getByTestId(`admin-order-refund-row-${refund.id}`)).toContainText(
        money(refund.amountMinor, afterAll.payment.currency),
      )
    }

    // After a full reload the page comes from the API's stored amounts, not the client's cache.
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    await expectPaymentPanel(page, await readOrder(request, token, order.orderNumber))
  })

  // Kills: a refund that still moves the status, a partially refunded order the admin cannot move on, a move that loses
  // what was refunded on the way, or a fully refunded order the UI can still ship.
  test('AC-18: an order refunded in part through the dialog keeps the badge Confirmed while the payment panel reads Partially refunded; it moves to Processing and ships through the dialog, badge Shipped, panel still Partially refunded, and GET /api/admin/orders/:n gives shipped, partially_refunded and refundedMinor = the amount, before and after a reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeOwnOrder(request, paidEmail('ship-after-refund'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment.capturedMinor
    expect(captured).toBe(start.totalMinor)
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part).toBeLessThan(captured)

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await refundThroughDialog(page, part)

    const refunded = await readOrder(request, token, order.orderNumber)
    expect([refunded.status, refunded.payment.state, refunded.payment.refundedMinor]).toEqual([
      'confirmed',
      'partially_refunded',
      part,
    ])
    await expectPaymentPanel(page, refunded)
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Confirmed')

    await page.getByTestId('admin-order-status-select').click({ timeout: 15_000 })
    await page.getByTestId('admin-order-status-option-processing').click()
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Processing', {
      timeout: 15_000,
    })

    await page.getByTestId('admin-order-status-select').click({ timeout: 15_000 })
    await page.getByTestId('admin-order-status-option-shipped').click()
    const dialog = page.getByTestId('admin-order-ship-dialog')
    await expect(dialog).toBeVisible()
    const trackingNumber = `RM${Date.now()}GB`
    await page.getByTestId('admin-order-ship-carrier').fill('Royal Mail')
    await page.getByTestId('admin-order-ship-tracking').fill(trackingNumber)
    await page.getByTestId('admin-order-ship-submit').click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Shipped', {
      timeout: 15_000,
    })

    const shipped = await readOrder(request, token, order.orderNumber)
    const moneyOf = (read: OrderRead) => [
      read.payment.state,
      read.payment.capturedMinor,
      read.payment.refundedMinor,
    ]
    expect(shipped.status).toBe('shipped')
    expect(moneyOf(shipped), 'the moves leave the money as the refund left it').toEqual(
      moneyOf(refunded),
    )
    await expectPaymentPanel(page, shipped)

    // After a full reload the page comes from the API's stored order, not the client's cache.
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Shipped')
    const reloaded = await readOrder(request, token, order.orderNumber)
    expect([reloaded.status, ...moneyOf(reloaded)]).toEqual([shipped.status, ...moneyOf(shipped)])
    await expectPaymentPanel(page, reloaded)
  })

  // Kills: a fully refunded order that can still be moved on through the select, or a refunded order the payment filter
  // does not find now that no status says refunded.
  test('AC-18: an order refunded in full keeps the badge Confirmed, the panel reads Refunded and the status is the plain label with no select; the orders list’s payment filter set to Refunded lists it', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeOwnOrder(request, paidEmail('refunded-whole'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment.capturedMinor

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await refundThroughDialog(page, captured)

    const refunded = await readOrder(request, token, order.orderNumber)
    expect([refunded.status, refunded.payment.state, refunded.payment.refundedMinor]).toEqual([
      'confirmed',
      'refunded',
      captured,
    ])
    await expectPaymentPanel(page, refunded)
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Confirmed')
    await expect(page.getByTestId('admin-order-status-select')).toHaveCount(0)

    await page.getByTestId('admin-nav-orders').click()
    const filter = page.getByTestId('admin-orders-payment-filter')
    await expect(filter).toBeVisible({ timeout: 15_000 })
    if ((await filter.evaluate((el) => el.tagName)) === 'SELECT') {
      await filter.selectOption({ label: 'Refunded' })
    } else {
      await filter.click()
      await page.getByRole('option', { name: 'Refunded', exact: true }).click()
    }
    const row = page.getByTestId(`admin-orders-row-${order.orderNumber}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`admin-orders-payment-${order.orderNumber}`)).toHaveText(
      LABEL.refunded,
    )
  })

  // A refund the server refuses shows its reason as money, not minor units. The dialog goes stale: the realtime
  // stream is down, and the order is refunded elsewhere after the dialog opened, so the dialog still offers the whole
  // capture and the server refuses it.
  test('a refund the server refuses from a stale dialog (over refundable) shows its reason in the store’s currency, not minor units, and moves no money', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await page.route('**/api/admin/events**', (route) => route.abort())
    const order = await placeOwnOrder(request, paidEmail('stale-refund'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment.capturedMinor
    const currency = start.payment.currency
    expect(captured).toBe(start.totalMinor)
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part).toBeLessThan(captured)

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await expectPaymentPanel(page, start)
    await page.getByTestId('admin-order-actions').click()
    await page.getByTestId('admin-order-action-refund').click()
    const dialog = page.getByTestId('admin-order-refund-dialog')
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-order-refund-amount').fill((captured / 100).toFixed(2))

    // Another admin refunds part of the order while this dialog is open.
    const elsewhere = await request.post(`${API_URL}/api/admin/orders/${order.orderId}/refund`, {
      headers: { ...(await csrf(request, API_URL)), authorization: `Bearer ${token}` },
      data: { amountMinor: part },
    })
    expect(elsewhere.status(), await elsewhere.text()).toBe(200)

    const refusal = page.waitForResponse(
      (r) => r.request().method() === 'POST' && REFUND_POST.test(new URL(r.url()).pathname),
    )
    await page.getByTestId('admin-order-refund-confirm').click()
    const refused = await refusal
    expect(refused.status()).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'refund.exceeds_captured',
    )

    const reason = dialog.getByRole('alert')
    await expect(reason).toContainText(money(captured, currency))
    await expect(reason).toContainText(money(captured - part, currency))
    const text = (await reason.textContent()) ?? ''
    for (const minor of [captured, captured - part]) {
      expect(text, `the reason shows ${minor} as minor units`).not.toMatch(
        new RegExp(`(^|[^\\d.,])${minor}([^\\d.,]|$)`),
      )
    }

    const after = await readOrder(request, token, order.orderNumber)
    expect(after.payment.refundedMinor).toBe(part)
    expect(after.payment.refundableMinor).toBe(captured - after.payment.refundedMinor)
  })

  // Kills: a provider refund that reaches the tables but not what the merchant reads, or a repeat that moves it again.
  test('AC-15: a paid order refunded in part by a stub provider webhook shows, after a reload, a Refunded row, Partially refunded, the amount, the status badge unchanged and one timeline entry; GET /api/admin/orders/:n agrees; delivering the same event again changes nothing', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const order = await placeOwnOrder(request, paidEmail('provider-refund'))
    const token = await adminToken(request)
    const start = await readOrder(request, token, order.orderNumber)
    const captured = start.payment.capturedMinor
    const part = Math.max(1, Math.floor(captured / 3))
    expect(part).toBeLessThan(captured)
    const signed = {
      rawBody: JSON.stringify({
        id: `evt_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        kind: 'payment.refunded',
        paymentIntentId: start.paymentIntentId,
        refund: { id: `re_e2e_${Date.now()}`, amountMinor: part },
      }),
      headers: { 'content-type': 'application/json', 'stripe-signature': 'proof-kit-stub' },
    }

    const answer = await postSignedWebhook(request, 'stripe', signed)
    expect(answer.status, JSON.stringify(answer)).toBe(200)
    const settled = await readOrder(request, token, order.orderNumber)
    expect(settled.payment.refundedMinor).toBe(part)
    expect(settled.payment.state).toBe('partially_refunded')
    expect(settled.status).toBe(start.status)
    const refund = settled.payment.refunds[0]!

    await signInAsAdmin(page)
    await openDetail(page, order.orderNumber)
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    await expectPaymentPanel(page, settled)
    await expect(page.getByTestId(`admin-order-refund-row-${refund.id}`)).toContainText(
      money(part, settled.currency),
    )
    await expect(page.getByTestId(`admin-order-refund-row-${refund.id}`)).toContainText(
      /refunded/i,
    )
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText(/confirmed/i)
    await page.getByTestId('admin-order-tab-timeline').click()
    await expect(page.getByTestId('admin-order-timeline-entry-refund')).toHaveCount(1, {
      timeout: 15_000,
    })

    await postSignedWebhook(request, 'stripe', signed)
    const again = await readOrder(request, token, order.orderNumber)
    expect([again.payment.refundedMinor, again.payment.refunds.length, again.status]).toEqual([
      part,
      1,
      start.status,
    ])
    await page.reload()
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    await page.getByTestId('admin-order-tab-timeline').click()
    await expect(page.getByTestId('admin-order-timeline-entry-refund')).toHaveCount(1, {
      timeout: 15_000,
    })
  })

  test('orders list page is accessible @a11y', async ({ page, request }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await placeOwnOrder(request)
    await loginAsAdmin(page)
    await page.getByTestId('admin-nav-orders').click()
    await expect(page.getByTestId(`admin-orders-row-${orderNumber}`)).toBeVisible({
      timeout: 15000,
    })
    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('order detail page is accessible @a11y', async ({ page, request }) => {
    test.setTimeout(60_000)
    const { orderNumber } = await placeOwnOrder(request)
    await loginAsAdmin(page)
    await openOrderDetail(page, orderNumber)
    await expect(page.getByTestId('admin-order-status-badge')).toHaveText('Pending')
    const AxeBuilder = (await import('@axe-core/playwright')).default
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })
})
