import { randomUUID } from 'node:crypto'
import type { APIRequestContext, TestInfo } from '@playwright/test'
import {
  complaint,
  permanentFailure,
  signedBody,
  temporaryFailure,
  type MailgunEventData,
} from '../../support/mailgun'
import {
  adjustStock,
  confirmThroughApi,
  customStoreEventsOfType,
  isBackInStock,
  isConfirmation,
  linkTo,
  mailbox,
  postWebhook,
  subscribeThroughApi,
  type LoggedEvent,
  type Mailbox,
} from '../support/alerts'
import { isCustomProject, storeCapabilities } from '../support/capabilities'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { expect, test } from '../support/fixtures'

// A bounced or complaining address gets no further alert mail. On the custom-providers store, whose email is Mailgun
// with its SMTP relay pointed at Mailpit, two shoppers confirm a back-in-stock alert on one variant; a signed Mailgun
// webhook for A, a permanent failure or a spam complaint, is received and logged; a temporary failure for B is too;
// the variant restocks, and Mailpit gets B's alert and none for A. On the native store, whose email only logs, there
// is no Mailgun adapter to post to (@capabilities).

function storefrontOrigin(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL
  if (base === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  return new URL(base).origin
}

const address = (role: string, tag: string): string => `bounce-${role}-${tag}@nymbal.dev`

/** Subscribed and confirmed through the API, as a shopper's browser and the storefront's server would. */
async function confirmedSubscriber(
  request: APIRequestContext,
  mail: Mailbox,
  origin: string,
  email: string,
  product: OwnProduct,
): Promise<void> {
  const sub = await subscribeThroughApi(request, origin, email, product.variantId)
  expect(sub.status, sub.text).toBe(202)
  const confirmations = (await mail.waitFor(email, 1)).filter(isConfirmation)
  expect(confirmations.length, `confirmations to ${email}`).toBe(1)
  const token = linkTo(confirmations[0]!, '/alerts/confirm').searchParams.get('token')
  const answer = await confirmThroughApi(request, token ?? '')
  expect(answer.status, answer.text).toBe(200)
}

const alertsTo = async (mail: Mailbox, to: string, product: OwnProduct) =>
  (await mail.messages(to)).filter((m) => isBackInStock(m, product.slug))

/** The one event of `type` the webhook post logged, once the store has delivered it to its handlers. */
async function deliveredEvent(correlationId: string, type: string): Promise<LoggedEvent> {
  let found: LoggedEvent[] = []
  await expect
    .poll(
      async () => {
        found = await customStoreEventsOfType(correlationId, type)
        return found.map((e) => e.deliveredAt != null)
      },
      { message: `${type} under ${correlationId}, delivered`, timeout: 30_000 },
    )
    .toEqual([true])
  return found[0]!
}

const FEEDBACK = [
  {
    what: 'a permanent failure',
    event: (to: string): MailgunEventData => permanentFailure(to),
    type: 'mailgun.bounced.v1',
  },
  {
    what: 'a spam complaint',
    event: (to: string): MailgunEventData => complaint(to),
    type: 'mailgun.complained.v1',
  },
] as const

test.describe('a bounced address gets no further alert mail', () => {
  for (const feedback of FEEDBACK) {
    test(`AC-6: a signed Mailgun webhook of ${feedback.what} for A is received and logged as ${feedback.type} for A, a temporary failure for B is received, and the restock mails B and not A @capabilities`, async ({
      request,
    }, testInfo) => {
      test.setTimeout(180_000)
      const caps = await storeCapabilities(request)
      const delivering = isCustomProject(testInfo.project.name)
      expect(caps.email.delivers, JSON.stringify(caps)).toBe(delivering)
      const tag = randomUUID().slice(0, 8)
      const [a, b] = [address('a', tag), address('b', tag)] as const

      if (!delivering) {
        const answer = await postWebhook(request, 'mailgun', signedBody(feedback.event(a)))
        expect([answer.status, answer.error?.code]).toEqual([404, 'webhook.not_found'])
        return
      }

      const origin = storefrontOrigin(testInfo)
      const mail = await mailbox()
      const token = await adminToken(request)
      const product = await ownProduct(request, token, 0)
      await confirmedSubscriber(request, mail, origin, a, product)
      await confirmedSubscriber(request, mail, origin, b, product)

      const forA = await postWebhook(request, 'mailgun', signedBody(feedback.event(a)))
      const forB = await postWebhook(request, 'mailgun', signedBody(temporaryFailure(b)))
      expect([forA.status, forA.data], JSON.stringify(forA)).toEqual([
        200,
        { received: true, events: 1 },
      ])
      expect([forB.status, forB.data], JSON.stringify(forB)).toEqual([
        200,
        { received: true, events: 1 },
      ])

      // The restock waits on both events reaching the store's handlers, so A is suppressed before it, if at all.
      const logged = await deliveredEvent(forA.correlationId, feedback.type)
      const soft = await deliveredEvent(forB.correlationId, 'mailgun.bounced.v1')
      expect(logged.payload?.['recipient']).toBe(a)
      expect([soft.payload?.['recipient'], soft.payload?.['bounce']]).toEqual([b, 'soft'])

      await adjustStock(request, token, product.variantId, 2, `bounce-ac6-${randomUUID()}`)

      // B's confirmation and then its alert; only once it is there is A's mail read.
      await mail.waitFor(b, 2)
      const toB = await alertsTo(mail, b, product)
      const toA = await alertsTo(mail, a, product)
      expect(toB.length, `back-in-stock emails to ${b}`).toBe(1)
      expect(toA, `back-in-stock emails to ${a}`).toEqual([])
      expect(toB.length).toBe(toA.length + 1)
    })
  }
})
