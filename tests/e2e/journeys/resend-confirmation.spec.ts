import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Browser, Locator, Page, TestInfo } from '@playwright/test'
import { signInAsAdmin } from '../support/admin'
import { linksIn, mailbox, type Mail, type Mailbox } from '../support/alerts'
import { isCustomProject } from '../support/capabilities'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { formatPrice } from '../support/variants'

// The admin resends an order's confirmation from the order page, on the custom-providers store, whose email is SMTP
// into Mailpit (@capabilities; the native store's email only logs, so there is nothing to read there). A guest order
// is placed and paid through the store's API, the admin selects Actions → Resend confirmation, and what is checked is
// what the shopper and the admin get: one more confirmation in Mailpit, a link whose key opens the order in a browser
// with nothing else, and one applied entry in Activity.

const ADMIN_BASE = `${API_URL}/admin/`
const COMMAND = 'order.resendConfirmation'
const ITEM = 'admin-order-action-resend-confirmation'
const RESULT = 'admin-order-resend-result'
const ORDER_KEY = /^[A-Za-z0-9_-]{43}$/

interface PaidOrder {
  orderId: string
  orderNumber: string
  buyer: string
  totalMinor: number
  currency: string
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** A guest order the store's payments adapter pays at checkout (an address with no stub trigger), on a product of its own. */
async function paidGuestOrder(
  request: APIRequestContext,
  token: string,
  mail: Mailbox,
  tag: string,
): Promise<PaidOrder> {
  const product = await ownProduct(request, token, 5)
  const buyer = `resend-${tag}-${randomUUID().slice(0, 8)}@nymbal.dev`
  const added = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request),
    data: { variantId: product.variantId, qty: 1 },
  })
  expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
  const address = {
    firstName: 'Resend',
    lastName: 'Shopper',
    addressLine1: '7 Mail Row',
    city: 'Leeds',
    region: 'West Yorkshire',
    postalCode: 'LS1 4AP',
    country: 'GB',
  }
  const res = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request),
    data: { email: buyer, billingAddress: address, shippingAddress: address },
  })
  expect(res.ok(), `POST /api/checkout: ${await res.text()}`).toBe(true)
  const { orderId, orderNumber } = ((await res.json()) as {
    data: { orderId: string; orderNumber: string }
  }).data
  // The checkout's own confirmation, so every count after it is the resend's.
  await mail.waitFor(buyer, 1)
  const read = await request.get(`${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`, {
    headers: auth(token),
  })
  const order = ((await read.json()) as { data: { status: string; totalMinor: number; currency: string } })
    .data
  expect(order.status, 'the paid order').toBe('confirmed')
  return { orderId, orderNumber, buyer, totalMinor: order.totalMinor, currency: order.currency }
}

const isOrderPlaced = (m: Mail, orderNumber: string): boolean =>
  m.subject === `Order ${orderNumber} confirmed`

async function confirmationsTo(mail: Mailbox, order: PaidOrder): Promise<Mail[]> {
  return (await mail.messages(order.buyer)).filter((m) => isOrderPlaced(m, order.orderNumber))
}

/** The `/order/<n>` links a mail carries. */
const orderLinks = (m: Mail, orderNumber: string): URL[] =>
  linksIn(m).filter((u) => u.pathname === `/order/${encodeURIComponent(orderNumber)}`)

/** The applied entries Activity lists for the command with the order as subject, by actor. */
async function appliedEntries(request: APIRequestContext, token: string, orderId: string) {
  const res = await request.get(`${API_URL}/api/admin/activity?command=${COMMAND}&outcome=applied`, {
    headers: auth(token),
  })
  expect(res.ok(), `GET /api/admin/activity: ${await res.text()}`).toBe(true)
  const entries = ((await res.json()) as {
    data: Array<{ actor: { kind: string; id: string }; subjects: Array<{ type: string; id: string }> }>
  }).data
  return entries
    .filter((e) => e.subjects.some((s) => s.type === 'order' && s.id === orderId))
    .map((e) => e.actor)
}

async function adminUserId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${API_URL}/api/admin/me`, { headers: auth(token) })
  return ((await res.json()) as { data: { userId: string } }).data.userId
}

/** The admin, signed in on a browser of its own, on the order's page. */
async function adminOnOrder(browser: Browser, order: PaidOrder): Promise<Page> {
  const admin = await (await browser.newContext()).newPage()
  await signInAsAdmin(admin, ADMIN_BASE)
  await admin.goto(new URL(`orders/${encodeURIComponent(order.orderNumber)}`, ADMIN_BASE).href)
  await expect(admin.getByTestId('admin-order-detail')).toBeVisible({ timeout: 15_000 })
  return admin
}

/** Counts the resend POSTs the admin page sends and the answers it gets. */
function watchResends(admin: Page) {
  const seen = { sent: 0, answered: 0 }
  const isResend = (url: string, method: string) =>
    method === 'POST' && new URL(url).pathname.endsWith('/resend-confirmation')
  admin.on('request', (req) => {
    if (isResend(req.url(), req.method())) seen.sent += 1
  })
  admin.on('response', (res) => {
    if (isResend(res.url(), res.request().method())) seen.answered += 1
  })
  return seen
}

async function openItem(admin: Page): Promise<Locator> {
  await admin.getByTestId('admin-order-actions').click()
  const item = admin.getByTestId(ITEM)
  await expect(item).toBeVisible()
  return item
}

/**
 * Once every resend the page sent is answered, the applied entries are final; waits for that many more confirmations
 * than `before`, then answers the entries and the confirmations.
 */
async function settled(
  admin: Page,
  seen: { sent: number; answered: number },
  request: APIRequestContext,
  token: string,
  mail: Mailbox,
  order: PaidOrder,
  before: number,
) {
  await expect(admin.getByTestId(RESULT)).toContainText(order.buyer, { timeout: 15_000 })
  await expect.poll(() => seen.answered - seen.sent, { timeout: 15_000 }).toBe(0)
  const entries = await appliedEntries(request, token, order.orderId)
  if (entries.length > 0) await mail.waitFor(order.buyer, before + entries.length)
  return { entries, confirmations: await confirmationsTo(mail, order) }
}

function skipOffMailpit(testInfo: TestInfo): void {
  test.skip(
    !isCustomProject(testInfo.project.name),
    'the native store’s email only logs: there is no Mailpit mail to read',
  )
}

test.describe('resending an order confirmation', () => {
  // Kills: the stub sending nothing; no link (no store.url on the store); a key that opens nothing; the item unwired.
  test('AC-10: the admin’s Resend confirmation on a paid guest order names the buyer, Mailpit gains one confirmation whose /order/<n>?key=<k> link carries a new 43-character key, that link opened in a browser with no cookies or storage shows the order’s number and total, and Activity lists one applied entry by the admin for the order @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    skipOffMailpit(testInfo)
    test.setTimeout(120_000)
    const mail = await mailbox()
    const token = await adminToken(request)
    const order = await paidGuestOrder(request, token, mail, 'ac10')
    const earlier = await confirmationsTo(mail, order)
    const earlierKeys = earlier.flatMap((m) =>
      orderLinks(m, order.orderNumber).map((u) => u.searchParams.get('key')),
    )

    const admin = await adminOnOrder(browser, order)
    const seen = watchResends(admin)
    await (await openItem(admin)).click()
    const { entries, confirmations } = await settled(
      admin,
      seen,
      request,
      token,
      mail,
      order,
      earlier.length,
    )

    expect(confirmations.length, 'confirmations after the resend').toBe(earlier.length + 1)
    const fresh = confirmations.filter((m) => !earlier.some((e) => e.text === m.text))
    expect(fresh.length, 'the new confirmation').toBe(1)
    const links = orderLinks(fresh[0]!, order.orderNumber)
    expect(links.length, `links to /order/${order.orderNumber} in "${fresh[0]!.text}"`).toBe(1)
    const key = links[0]!.searchParams.get('key') ?? ''
    expect(key).toMatch(ORDER_KEY)
    expect(earlierKeys.filter((k) => k === key), 'the key in an earlier mail').toEqual([])

    // A browser with no cookies and no storage, on this project's storefront: the key belongs to the API.
    const baseURL = testInfo.project.use.baseURL
    const elsewhere = await (
      await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
    ).newPage()
    try {
      await elsewhere.goto(`${links[0]!.pathname}${links[0]!.search}`)
      await expect(elsewhere.getByTestId('order-number')).toHaveText(order.orderNumber, {
        timeout: 15_000,
      })
      await expect(elsewhere.getByTestId('order-summary')).toContainText(
        formatPrice(order.totalMinor, order.currency),
      )
    } finally {
      await elsewhere.context().close()
    }

    expect(entries).toEqual([{ kind: 'admin', id: await adminUserId(request, token) }])
    await admin.context().close()
  })

  // Kills: an item neither disabled nor de-duplicated while its request is in flight, so k clicks make k commands.
  test('AC-11: a double-click on Resend confirmation, and Enter on the focused item followed by a click, each add exactly one confirmation for the buyer and one applied entry @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    skipOffMailpit(testInfo)
    test.setTimeout(150_000)
    const mail = await mailbox()
    const token = await adminToken(request)

    const gestures: Array<[string, (item: Locator) => Promise<void>]> = [
      ['a double-click', (item) => item.dblclick()],
      [
        'Enter, then a click',
        async (item) => {
          await item.focus()
          await item.press('Enter')
          // Dispatched at once, as a second press lands. The menu has no close animation, so the item may already be
          // gone: the click reaches it while it is still in the page and never waits for it to come back.
          await item.page().evaluate((id) => {
            document
              .querySelector(`[data-testid="${id}"]`)
              ?.dispatchEvent(
                new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }),
              )
          }, ITEM)
        },
      ],
    ]
    const outcomes: Array<[string, number, number]> = []
    for (const [gesture, act] of gestures) {
      const order = await paidGuestOrder(request, token, mail, 'ac11')
      const before = (await confirmationsTo(mail, order)).length
      const admin = await adminOnOrder(browser, order)
      const seen = watchResends(admin)
      await act(await openItem(admin))
      const { entries, confirmations } = await settled(
        admin,
        seen,
        request,
        token,
        mail,
        order,
        before,
      )
      outcomes.push([gesture, confirmations.length - before, entries.length])
      await admin.context().close()
    }
    expect(outcomes, '[gesture, confirmations added, applied entries]').toEqual(
      gestures.map(([gesture]) => [gesture, 1, 1]),
    )
  })
})
