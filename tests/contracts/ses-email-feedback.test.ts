import { describe, expect, it } from 'vitest'
import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createSesEmailAdapter } from '../../packages/adapters/email/ses/src/index.js'
import {
  changeOneCharacter,
  notification,
  SES_TEST_CERT_URL,
  SES_TEST_REGION,
  SES_TEST_TOPIC,
  sesBounce,
  sesComplaint,
  sesPolicyRejection,
  sesTestSigner,
  signedSnsPost,
  type SesRequest,
} from '../support/ses'

// The email feedback contract and the webhook contract on @nymbalhq/email-ses, with the test certificate injected
// through fetchCertificate and the store on the test topic. A sample is built afresh on every call under the same SNS
// MessageId and the same SES message, as SNS retries one message: so a sample received twice is SNS's retry of it. SNS
// signs the Message, so the tampered delivery changes one character of the recipient inside it.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const AT = { at: '2026-10-29T12:00:00.250Z', mailTimestamp: '2026-10-29T11:59:58.000Z' }
const SNS_AT = '2026-10-29T12:00:01.000Z'
const HARD = 'hard@contracts.test'
const SOFT = 'soft@contracts.test'
const COMPLAINT = 'complaint@contracts.test'
const POLICY = 'policy@contracts.test'

const build = () =>
  createSesEmailAdapter({
    logger,
    config: {
      from: 'shop@contracts.test',
      region: SES_TEST_REGION,
      smtp: { host: '127.0.0.1', port: 1, user: 'AKIACONTRACTS', pass: 'contracts-pass' },
      topicArn: SES_TEST_TOPIC,
    },
    fetchCertificate: async (url: string) => {
      if (url !== SES_TEST_CERT_URL) throw new Error(`no certificate at ${url}`)
      return sesTestSigner().pem
    },
  })

const hardBounce = sesBounce([HARD], 'Permanent', { ...AT, mailMessageId: 'mail-hard' })
const softBounce = sesBounce([SOFT], 'Transient', { ...AT, mailMessageId: 'mail-soft' })
const complaint = sesComplaint([COMPLAINT], {
  ...AT,
  kindField: 'eventType',
  mailMessageId: 'mail-complaint',
})

/** A recipient's server refusing the store's sending host, as SES reports it: Permanent, its recipient's status 5.7.1. */
const policyBounce = sesPolicyRejection([POLICY], { ...AT, mailMessageId: 'mail-policy' })

const post = (ses: object, messageId: string): SesRequest =>
  signedSnsPost(notification(ses, { messageId, timestamp: SNS_AT }))

runEmailFeedbackContract('ses', build, {
  bounce: () => ({ request: post(hardBounce, 'sns-hard'), recipient: HARD }),
  softBounce: () => ({ request: post(softBounce, 'sns-soft'), recipient: SOFT }),
  complaint: () => ({ request: post(complaint, 'sns-complaint'), recipient: COMPLAINT }),
  policyRejection: () => ({ request: post(policyBounce, 'sns-policy'), recipient: POLICY }),
})

const delivery = (): SesRequest => post(hardBounce, 'sns-delivery')

/** The delivery with one character of the recipient, inside the signed Message, changed after signing. */
const tampered = (): SesRequest => {
  const real = delivery()
  const body = real.rawBody.toString('utf8')
  return { ...real, rawBody: Buffer.from(changeOneCharacter(body, body.indexOf(HARD)), 'utf8') }
}

runWebhookContract('ses', build, { delivery, tampered })

describe('the policy rejection sample', () => {
  it('AC-6: SES hands the policy rejection sample on soft, and the same bounce with 5.1.1 in place of 5.7.1 hard', async () => {
    const mailbox = JSON.parse(JSON.stringify(policyBounce).replaceAll('5.7.1', '5.1.1')) as object

    const handedOn: unknown[] = []
    for (const [ses, id] of [
      [policyBounce, 'sns-policy'],
      [mailbox, 'sns-mailbox'],
    ] as const) {
      const { rawBody, headers } = post(ses, id)
      const delivery = await build().receiveWebhook!(rawBody, headers)
      handedOn.push(delivery.events.map((e) => [e.payload['recipient'], e.payload['bounce']]))
    }

    const recipients = policyBounce.bounce!.bouncedRecipients.map((r) => r.emailAddress)
    expect(handedOn).toEqual([
      recipients.map((to) => [to, 'soft']),
      recipients.map((to) => [to, 'hard']),
    ])
  })
})
