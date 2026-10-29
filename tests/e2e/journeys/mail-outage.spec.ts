import { randomUUID } from 'node:crypto'
import type { APIRequestContext, TestInfo } from '@playwright/test'
import {
  adjustStock,
  confirmThroughApi,
  customStoreEvents,
  isBackInStock,
  isConfirmation,
  linkTo,
  mailbox,
  mailChaos,
  type LoggedEvent,
  type Mailbox,
} from '../support/alerts'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// A mail outage on the custom-providers store, whose email is Mailgun relaying into Mailpit: with Mailpit's Chaos
// refusing every recipient, an alert confirmation and a back-in-stock alert are not sent, and their events stay in the
// store's log with a failed attempt; once the outage ends, the store's own retries (the default delay, 10 s and
// doubling) send each mail once. The journey drives the API and Mailpit only, once, against the store's API alone: no
// storefront page. Chaos applies to the whole Mailpit, so nothing else may mail it while this runs, and it is off
// again at the end whatever happens.

/** How long each phase waits on the store's retries and on Mailpit. */
const PHASE_MS = 60_000

function storefrontOrigin(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL
  if (base === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  return new URL(base).origin
}

/** `POST /api/alerts/subscribe` from the storefront's browser, under a correlation id the journey chooses. */
async function subscribe(
  request: APIRequestContext,
  origin: string,
  email: string,
  product: OwnProduct,
  correlationId: string,
): Promise<void> {
  const res = await request.post(`${API_URL}/api/alerts/subscribe`, {
    headers: { ...(await csrf(request)), origin, 'x-correlation-id': correlationId },
    data: { email, variantId: product.variantId, kind: 'back_in_stock' },
  })
  expect(res.status(), `subscribe ${email}: ${await res.text()}`).toBe(202)
}

// A confirmation carries no product link (its links are confirm and unsubscribe): its subject names the product.
const confirmationsFor = async (mail: Mailbox, to: string, product: OwnProduct) =>
  (await mail.messages(to)).filter((m) => isConfirmation(m) && m.subject.includes(product.name))

const alertsFor = async (mail: Mailbox, to: string, product: OwnProduct) =>
  (await mail.messages(to)).filter((m) => isBackInStock(m, product.slug))

/** The one event of `type` the correlation id logged; undefined until it is there. */
async function logged(correlationId: string, type: string): Promise<LoggedEvent | undefined> {
  const found = (await customStoreEvents(correlationId, type.replace(/\.[^.]+\.v1$/, '.*'))).filter(
    (e) => e.type === type,
  )
  return found.length === 1 ? found[0] : undefined
}

/** Where the event is: whether a delivery has failed, and whether it is delivered. */
async function delivery(correlationId: string, type: string): Promise<[boolean, boolean]> {
  const e = await logged(correlationId, type)
  return [(e?.attempts ?? 0) >= 1, e?.deliveredAt != null]
}

test.describe('a mail outage @mail-outage', () => {
  test.beforeAll(async () => {
    await mailChaos('off')
  })

  test('AC-11: with Mailpit refusing every recipient, a subscribe and then a restock put nothing in Mailpit and leave their events undelivered after a failed attempt; once the outage ends, the store’s retries send the one confirmation and the one back-in-stock alert, and a later subscribe’s confirmation finds no second copy of either', async ({
    request,
  }, testInfo) => {
    test.setTimeout(300_000)
    const origin = storefrontOrigin(testInfo)
    const mail = await mailbox()
    const token = await adminToken(request)
    const p = await ownProduct(request, token, 0)
    const tag = randomUUID().slice(0, 8)
    const email = `mail-outage-${tag}@nymbal.dev`
    try {
      // The outage, then a subscribe: no confirmation, and alert.requested.v1 has failed and waits.
      await mailChaos('on')
      const subscribed = `mail-outage-subscribe-${randomUUID()}`
      await subscribe(request, origin, email, p, subscribed)
      await expect
        .poll(() => delivery(subscribed, 'alert.requested.v1'), {
          timeout: PHASE_MS,
          message: 'alert.requested.v1: [a failed attempt, delivered]',
        })
        .toEqual([true, false])
      expect(await mail.messages(email), 'mail during the outage').toEqual([])
      const failedAttempts = (await logged(subscribed, 'alert.requested.v1'))?.attempts ?? 0

      // The outage ends: the retry sends one confirmation for P, and the event is delivered.
      await mailChaos('off')
      await expect
        .poll(async () => (await confirmationsFor(mail, email, p)).length, {
          timeout: PHASE_MS,
          message: `confirmations for ${p.slug} after the outage`,
        })
        .toBe(1)
      await expect
        .poll(() => delivery(subscribed, 'alert.requested.v1'), { timeout: PHASE_MS })
        .toEqual([true, true])
      expect(
        (await logged(subscribed, 'alert.requested.v1'))?.attempts ?? 0,
        'attempts once delivered, against those seen during the outage',
      ).toBeGreaterThanOrEqual(failedAttempts)
      const [confirmation] = await confirmationsFor(mail, email, p)
      const confirmToken = linkTo(confirmation!, '/alerts/confirm').searchParams.get('token') ?? ''
      const confirmed = await confirmThroughApi(request, confirmToken)
      expect(confirmed.status, confirmed.text).toBe(200)

      // A second outage, then P's restock from 0: no alert, and product.restocked.v1 has failed and waits.
      await mailChaos('on')
      const restocked = `mail-outage-restock-${randomUUID()}`
      await adjustStock(request, token, p.variantId, 2, restocked)
      await expect
        .poll(() => delivery(restocked, 'product.restocked.v1'), {
          timeout: PHASE_MS,
          message: 'product.restocked.v1: [a failed attempt, delivered]',
        })
        .toEqual([true, false])
      expect(await alertsFor(mail, email, p), 'alerts during the outage').toEqual([])

      // The outage ends: the retry sends one back-in-stock alert for P, and the event is delivered.
      await mailChaos('off')
      await expect
        .poll(async () => (await alertsFor(mail, email, p)).length, {
          timeout: PHASE_MS,
          message: `back-in-stock alerts for ${p.slug} after the outage`,
        })
        .toBe(1)
      await expect
        .poll(() => delivery(restocked, 'product.restocked.v1'), { timeout: PHASE_MS })
        .toEqual([true, true])

      // The marker: a subscribe to Q, sent after both retries. Once its confirmation is here, a second copy of
      // either retried mail would be too.
      const q = await ownProduct(request, token, 0)
      await subscribe(request, origin, email, q, `mail-outage-marker-${randomUUID()}`)
      await expect
        .poll(async () => (await confirmationsFor(mail, email, q)).length, {
          timeout: PHASE_MS,
          message: `the marker's confirmation for ${q.slug}`,
        })
        .toBe(1)
      const [confirmationsOfP, alertsOfP] = await Promise.all([
        confirmationsFor(mail, email, p),
        alertsFor(mail, email, p),
      ])
      expect([confirmationsOfP.length, alertsOfP.length], `mail for ${p.slug}`).toEqual([1, 1])
    } finally {
      await mailChaos('off')
    }
  })
})
