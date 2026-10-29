import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  eventBody,
  signEasyPost,
  EASYPOST_SIGNATURE_HEADER,
  EASYPOST_TEST_WEBHOOK_SECRET,
  trackerEvent,
  type EasyPostEvent,
} from '../../support/easypost'
import { customStoreEventsOfType } from '../support/alerts'
import { isCustomProject } from '../support/capabilities'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  ORDER_KEY_HEADER,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { postSignedWebhook } from '../support/webhooks'

// A carrier delivers an order. On the custom-providers store, whose shipping is EasyPost with the tests' webhook
// secret, an order placed through the storefront's checkout is processed and shipped with tracking number N through
// the admin API (the admin's Mark Shipped button is not the subject here); a signed EasyPost in_transit update for N
// changes nothing, and a signed delivered tracker.updated for N delivers it: the guest's /order/<n> timeline ends
// "Delivered" and the API gives `delivered`. Each post is the signed string itself, never an object re-serialised. On
// the native store, whose shipping takes no webhooks, there is no EasyPost adapter to post to (@capabilities).

const TRACKING = 'easypost.tracking.v1'

const LABELS: Record<string, string> = {
  placed: 'Order placed',
  paid: 'Payment received',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
}

interface ApiOrder {
  id: string
  status: string
  timeline?: Array<{ kind: string; at: string }>
}

async function apiOrder(
  request: APIRequestContext,
  orderNumber: string,
  key: string,
): Promise<ApiOrder> {
  const res = await request.get(`${API_URL}/api/orders/${encodeURIComponent(orderNumber)}`, {
    headers: { [ORDER_KEY_HEADER]: key },
  })
  expect(res.status(), `GET /api/orders/${orderNumber}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ApiOrder }).data
}

/** One admin command on the order, through the admin API. */
async function adminPost(
  request: APIRequestContext,
  token: string,
  orderId: string,
  command: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const res = await request.post(`${API_URL}/api/admin/orders/${orderId}/${command}`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data,
  })
  expect(res.status(), `POST /api/admin/orders/:id/${command}: ${await res.text()}`).toBe(200)
}

/** EasyPost's post of `event`: the signed string, and its header, signed with the store's secret. */
function signed(event: EasyPostEvent): { rawBody: string; headers: Record<string, string> } {
  const rawBody = eventBody(event)
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      [EASYPOST_SIGNATURE_HEADER]: signEasyPost(rawBody, EASYPOST_TEST_WEBHOOK_SECRET),
    },
  }
}

/** The tracking update the post logged has reached the store's handlers, so whatever it moves has moved. */
async function handled(correlationId: string): Promise<Record<string, unknown> | undefined> {
  let found: Awaited<ReturnType<typeof customStoreEventsOfType>> = []
  await expect
    .poll(
      async () => {
        found = await customStoreEventsOfType(correlationId, TRACKING)
        return found.map((e) => e.deliveredAt != null)
      },
      { message: `${TRACKING} under ${correlationId}, delivered`, timeout: 30_000 },
    )
    .toEqual([true])
  return found[0]!.payload
}

async function placeThroughCheckout(page: Page, request: APIRequestContext, token: string) {
  const product = await ownProduct(request, token, 5)
  await openCheckout(page, product)
  await walkToPayment(page, `e2e-carrier-${randomUUID().slice(0, 8)}@e2e.test`)
  await page.getByTestId('place-order').click()
  await page.waitForURL(/\/order\//, { timeout: 20_000 })
  return { orderNumber: orderNumberOf(page), key: orderKeyOf(page) }
}

const freshTrackingNumber = (): string =>
  `9400${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`

test.describe('a carrier delivers an order', () => {
  test('AC-6: checkout.carrier-delivers: on the custom store, an order placed through the checkout and shipped with N through the admin API is unchanged by a signed EasyPost in_transit update for N, and a signed delivered tracker.updated for N answers 200 with one event, ends its /order/<n> timeline "Delivered" and makes GET /api/orders/:n delivered @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const trackingNumber = freshTrackingNumber()

    if (!isCustomProject(testInfo.project.name)) {
      const answer = await postSignedWebhook(
        request,
        'easypost',
        signed(trackerEvent(trackingNumber, 'delivered')),
      )
      expect([answer.status, answer.error?.code]).toEqual([404, 'webhook.not_found'])
      return
    }

    const token = await adminToken(request)
    const { orderNumber, key } = await placeThroughCheckout(page, request, token)
    const placed = await apiOrder(request, orderNumber, key)
    expect(placed.status, 'the custom payments captured at checkout').toBe('confirmed')

    await adminPost(request, token, placed.id, 'process')
    await adminPost(request, token, placed.id, 'ship', { carrier: 'USPS', trackingNumber })
    await expect
      .poll(async () => (await apiOrder(request, orderNumber, key)).status, { timeout: 10_000 })
      .toBe('shipped')
    const shipped = await apiOrder(request, orderNumber, key)
    const shippedLabels = (shipped.timeline ?? []).map((e) => LABELS[e.kind] ?? e.kind)
    expect(shippedLabels.at(-1), JSON.stringify(shipped.timeline)).toBe('Shipped')

    const labels = page.getByTestId('timeline-entry').locator('[part~="label"]')
    await page.goto(keyedOrderPath(orderNumber, key))
    await expect(labels).toHaveText(shippedLabels, { timeout: 15_000 })

    const moving = await postSignedWebhook(
      request,
      'easypost',
      signed(trackerEvent(trackingNumber, 'in_transit')),
    )
    expect([moving.status, moving.data], JSON.stringify(moving)).toEqual([
      200,
      { received: true, events: 1 },
    ])
    const movingPayload = await handled(moving.correlationId)
    expect([movingPayload?.['trackingNumber'], movingPayload?.['status']]).toEqual([
      trackingNumber,
      'in_transit',
    ])
    await page.reload()
    await expect(labels).toHaveText(shippedLabels, { timeout: 15_000 })
    expect((await apiOrder(request, orderNumber, key)).status).toBe(shipped.status)

    const delivered = await postSignedWebhook(
      request,
      'easypost',
      signed(trackerEvent(trackingNumber, 'delivered')),
    )
    expect([delivered.status, delivered.data], JSON.stringify(delivered)).toEqual([
      200,
      { received: true, events: 1 },
    ])
    await expect
      .poll(async () => (await apiOrder(request, orderNumber, key)).status, { timeout: 15_000 })
      .toBe('delivered')
    await page.reload()
    await expect(labels).toHaveText([...shippedLabels, 'Delivered'], { timeout: 15_000 })
    const served = await apiOrder(request, orderNumber, key)
    const shownKinds = await page
      .getByTestId('timeline-entry')
      .evaluateAll((els) => els.map((li) => li.getAttribute('data-kind') ?? ''))
    expect(shownKinds, 'the page’s entries against the API’s timeline').toEqual(
      (served.timeline ?? []).map((e) => e.kind),
    )
    expect(shownKinds.length).toBe(shippedLabels.length + 1)
  })
})
