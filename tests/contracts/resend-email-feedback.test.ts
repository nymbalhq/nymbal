import { describe, expect, it } from 'vitest'
import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createResendEmailAdapter } from '../../packages/adapters/email/resend/src/index.js'
import {
  bounced,
  changeOneCharacter,
  complained,
  policyRejected,
  RESEND_TEST_SECRET,
  signedPost,
  type ResendEvent,
  type ResendRequest,
} from '../support/resend'

// The email feedback contract and the webhook contract on @nymbalhq/email-resend with a test webhook secret. Each
// sample is signed afresh on every call under the same svix-id, as Svix signs a retry of one message again with a new
// timestamp, so a sample received twice is Resend's retry of it. Svix signs the body, so the tampered delivery
// changes one byte of it.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const AT = { createdAt: new Date('2026-10-29T12:00:00.250Z') }
const HARD = 'hard@contracts.test'
const SOFT = 'soft@contracts.test'
const COMPLAINT = 'complaint@contracts.test'
const POLICY = 'policy@contracts.test'

const build = () =>
  createResendEmailAdapter({
    logger,
    config: {
      from: 'shop@contracts.test',
      smtp: { host: '127.0.0.1', port: 1, pass: 're_contracts_key' },
      webhookSecret: RESEND_TEST_SECRET,
    },
  })

const hardBounce = bounced([HARD], 'Permanent', { ...AT, emailId: 'email-hard' })
/** A recipient's server refusing the store's sending host, as Resend reports it: Permanent, 5.7.1 in its message. */
const policyBounce = policyRejected([POLICY], { ...AT, emailId: 'email-policy' })

runEmailFeedbackContract('resend', build, {
  bounce: () => ({ request: signedPost(hardBounce, { id: 'msg_hard' }), recipient: HARD }),
  softBounce: () => ({
    request: signedPost(bounced([SOFT], 'Transient', { ...AT, emailId: 'email-soft' }), {
      id: 'msg_soft',
    }),
    recipient: SOFT,
  }),
  complaint: () => ({
    request: signedPost(complained([COMPLAINT], { ...AT, emailId: 'email-complaint' }), {
      id: 'msg_complaint',
    }),
    recipient: COMPLAINT,
  }),
  policyRejection: () => ({
    request: signedPost(policyBounce, { id: 'msg_policy' }),
    recipient: POLICY,
  }),
})

const delivery = (): ResendRequest => signedPost(hardBounce, { id: 'msg_delivery' })

/** The delivery with one byte of the recipient changed after signing. */
const tampered = (): ResendRequest => {
  const real = delivery()
  const body = real.rawBody.toString('utf8')
  return { ...real, rawBody: Buffer.from(changeOneCharacter(body, body.indexOf(HARD)), 'utf8') }
}

runWebhookContract('resend', build, { delivery, tampered })

describe('the policy rejection sample', () => {
  it('AC-6: Resend hands the policy rejection sample on soft, and the same bounce with 5.1.1 in place of 5.7.1 hard', async () => {
    const mailbox = JSON.parse(
      JSON.stringify(policyBounce).replaceAll('5.7.1', '5.1.1'),
    ) as ResendEvent

    const handedOn: unknown[] = []
    for (const [event, id] of [
      [policyBounce, 'msg_policy'],
      [mailbox, 'msg_mailbox'],
    ] as const) {
      const { rawBody, headers } = signedPost(event, { id })
      const delivery = await build().receiveWebhook!(rawBody, headers)
      handedOn.push(delivery.events.map((e) => [e.payload['recipient'], e.payload['bounce']]))
    }

    expect(handedOn).toEqual([
      policyBounce.data.to.map((to) => [to, 'soft']),
      mailbox.data.to.map((to) => [to, 'hard']),
    ])
  })
})
