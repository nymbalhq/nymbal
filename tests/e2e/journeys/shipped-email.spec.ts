import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import {
  customStoreEventsOfType,
  linksIn,
  mailbox,
  type Mail,
  type Mailbox,
} from '../support/alerts'
import { isCustomProject } from '../support/capabilities'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// The shopper's shipped email. On the custom-providers store, whose email is Mailgun relaying into Mailpit, a guest
// order is placed and paid through the store's API, processed and shipped through the admin API with USPS and a fresh
// number, and what is checked is the mail the shopper gets: one, naming the carrier, the number and each line with
// its quantity, linking to USPS's tracker for that number and to the order on the storefront through a key that
// opens it in a browser with nothing else. A second ship is refused and mails nothing more. The native store's email
// only logs (@capabilities): there the ship and its refusal are what is checked.

const SHIPPED_EVENT = 'order.shipped.v1'
const CORRELATION = 'x-correlation-id'
const QTY = 2

interface PaidOrder {
  orderId: string
  orderNumber: string
  buyer: string
  product: OwnProduct
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** A guest order of QTY of a product of its own, paid at checkout by the store's payments adapter. */
async function paidGuestOrder(request: APIRequestContext, token: string): Promise<PaidOrder> {
  const product = await ownProduct(request, token, 5)
  const buyer = `shipped-${randomUUID().slice(0, 8)}@nymbal.dev`
  const added = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request),
    data: { variantId: product.variantId, qty: QTY },
  })
  expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
  const address = {
    firstName: 'Parcel',
    lastName: 'Shopper',
    addressLine1: '9 Dispatch Lane',
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
  const { orderId, orderNumber } = (
    (await res.json()) as {
      data: { orderId: string; orderNumber: string }
    }
  ).data
  return { orderId, orderNumber, buyer, product }
}

/** One admin command on the order through the admin API: its status and correlation id. */
async function adminPost(
  request: APIRequestContext,
  token: string,
  orderId: string,
  command: string,
  data: Record<string, unknown> = {},
) {
  const res = await request.post(`${API_URL}/api/admin/orders/${orderId}/${command}`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data,
  })
  return { status: res.status(), text: await res.text(), correlationId: res.headers()[CORRELATION] }
}

const freshTrackingNumber = (): string =>
  `9400${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`

const isShipped = (m: Mail, orderNumber: string): boolean =>
  m.subject === `Order ${orderNumber} is on its way`

async function shippedMails(mail: Mailbox, order: PaidOrder): Promise<Mail[]> {
  return (await mail.messages(order.buyer)).filter((m) => isShipped(m, order.orderNumber))
}

/** Whether `line` holds `n` as a number of its own, not as a digit of another. */
const holdsNumber = (line: string, n: number): boolean =>
  new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(line)

test.describe('the shipped email', () => {
  // Kills: no shipped email on a real SMTP path; the subject, carrier, number or a line's quantity missing; a tracking
  // link to another host or without the number; a mailed key that does not open the order on a storefront; a second
  // ship that mails again.
  test('AC-10: a paid guest order processed and shipped through the admin API with USPS and a fresh number N puts one "Order <n> is on its way" mail in Mailpit for the buyer, naming USPS, N and the line with its quantity, with one tools.usps.com link holding N and one /order/<n>?key=<k> link that opens the order on the storefront in a fresh browser; a second ship answers non-2xx and the mailbox still holds one shipped mail @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const token = await adminToken(request)
    const order = await paidGuestOrder(request, token)
    const trackingNumber = freshTrackingNumber()
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API_URL}/api/admin/orders/${encodeURIComponent(order.orderNumber)}`,
            { headers: auth(token) },
          )
          return ((await res.json()) as { data?: { status?: string } }).data?.status
        },
        { message: 'the paid order', timeout: 15_000 },
      )
      .toBe('confirmed')

    const processed = await adminPost(request, token, order.orderId, 'process')
    expect(processed.status, `POST …/process: ${processed.text}`).toBe(200)
    const shipped = await adminPost(request, token, order.orderId, 'ship', {
      carrier: 'USPS',
      trackingNumber,
    })
    expect(shipped.status, `POST …/ship: ${shipped.text}`).toBe(200)
    const again = await adminPost(request, token, order.orderId, 'ship', {
      carrier: 'USPS',
      trackingNumber: freshTrackingNumber(),
    })
    expect(again.status >= 300, `a second POST …/ship answered ${again.status}`).toBe(true)

    if (!isCustomProject(testInfo.project.name)) {
      // The native store's email only logs: the ship stands and the second is refused, whatever the email does.
      return
    }

    const mail = await mailbox()
    // Every subscriber has had the ship's event, so whatever it sends has been sent.
    await expect
      .poll(
        async () =>
          (await customStoreEventsOfType(shipped.correlationId ?? '', SHIPPED_EVENT)).map(
            (e) => e.deliveredAt != null,
          ),
        { message: `${SHIPPED_EVENT} under the ship’s correlation id, delivered`, timeout: 30_000 },
      )
      .toEqual([true])
    await expect
      .poll(async () => (await shippedMails(mail, order)).length, {
        message: `shipped mails to ${order.buyer}`,
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1)
    const mails = await shippedMails(mail, order)
    expect(mails.length, 'shipped mails for the order').toBe(1)
    const text = mails[0]!.text

    expect([text.includes('USPS'), text.includes(trackingNumber)], text).toEqual([true, true])
    const itemLines = text
      .split('\n')
      // The quantity is read beside the name, never from the digits of the name's own tag.
      .filter(
        (line) =>
          line.includes(order.product.name) &&
          holdsNumber(line.replace(order.product.name, ' '), QTY),
      )
    expect(itemLines.length, `a line naming ${order.product.name} and ${QTY} in "${text}"`).toBe(1)

    const links = linksIn(mails[0]!)
    const usps = links.filter((u) => u.hostname === 'tools.usps.com')
    expect(
      usps.map((u) => u.href.includes(trackingNumber)),
      `USPS links in "${text}"`,
    ).toEqual([true])
    const orderLinks = links.filter(
      (u) =>
        u.pathname === `/order/${encodeURIComponent(order.orderNumber)}` &&
        (u.searchParams.get('key') ?? '') !== '',
    )
    expect(orderLinks.length, `keyed /order/${order.orderNumber} links in "${text}"`).toBe(1)

    // A browser with no cookies and no storage, on this project's storefront: the key alone opens the order.
    const baseURL = testInfo.project.use.baseURL
    const elsewhere = await (
      await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
    ).newPage()
    try {
      await elsewhere.goto(`${orderLinks[0]!.pathname}${orderLinks[0]!.search}`)
      await expect(elsewhere.getByTestId('order-number')).toHaveText(order.orderNumber, {
        timeout: 15_000,
      })
    } finally {
      await elsewhere.context().close()
    }

    expect((await shippedMails(mail, order)).length, 'shipped mails after the second ship').toBe(1)
  })
})
