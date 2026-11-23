import { describe, expect, it } from 'vitest'
import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createMailgunEmailAdapter } from '../../packages/adapters/email/mailgun/src/index.js'
import {
  changeOneCharacter,
  complaint,
  MAILGUN_TEST_SIGNING_KEY,
  mailgunRequest,
  permanentFailure,
  policyRejection,
  signedBody,
  signedPost,
  temporaryFailure,
  type MailgunEventData,
  type MailgunSignature,
} from '../support/mailgun'

// The email feedback contract and the webhook contract on @nymbalhq/email-mailgun with a test signing key. Each
// sample is signed afresh on every call, as Mailgun signs each post with a new token (the adapter takes a token once),
// so a sample received twice is Mailgun's retry of one event: its `event-data.id` is the delivery. Mailgun signs only
// `signature.timestamp` and `signature.token`, so the tampered delivery changes a byte of the token.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const AT = Date.parse('2026-10-29T12:00:00.250Z') / 1000
const HARD = 'hard@contracts.test'
const SOFT = 'soft@contracts.test'
const COMPLAINT = 'complaint@contracts.test'
const POLICY = 'policy@contracts.test'

/** A recipient's server refusing the store's sending host, as Mailgun reports it: permanent, 5.7.1. */
const policySample = (): MailgunEventData =>
  policyRejection(POLICY, { id: 'mg-policy', timestamp: AT })

const build = () =>
  createMailgunEmailAdapter({
    logger,
    config: {
      from: 'shop@contracts.test',
      smtp: { host: '127.0.0.1', port: 1, user: 'postmaster@mg.contracts.test', pass: 'smtp-pass' },
      webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
    },
  })

runEmailFeedbackContract('mailgun', build, {
  bounce: () => ({
    request: signedPost(permanentFailure(HARD, { id: 'mg-hard', timestamp: AT })),
    recipient: HARD,
  }),
  softBounce: () => ({
    request: signedPost(temporaryFailure(SOFT, { id: 'mg-soft', timestamp: AT })),
    recipient: SOFT,
  }),
  complaint: () => ({
    request: signedPost(complaint(COMPLAINT, { id: 'mg-complaint', timestamp: AT })),
    recipient: COMPLAINT,
  }),
  policyRejection: () => ({ request: signedPost(policySample()), recipient: POLICY }),
})

const delivery = () => signedPost(permanentFailure(HARD, { id: 'mg-delivery', timestamp: AT }))

runWebhookContract('mailgun', build, {
  delivery,
  tampered: () => {
    const real = signedBody(permanentFailure(HARD, { id: 'mg-delivery', timestamp: AT }))
    const signature = real.signature as MailgunSignature
    return mailgunRequest({
      ...real,
      signature: { ...signature, token: changeOneCharacter(signature.token, 17) },
    })
  },
})

describe('the policy rejection sample', () => {
  it('AC-6: Mailgun hands the policy rejection sample on soft, and the same failure with 5.1.1 in place of 5.7.1 hard', async () => {
    const policy = policySample()
    const mailbox = {
      ...(JSON.parse(JSON.stringify(policy).replaceAll('5.7.1', '5.1.1')) as MailgunEventData),
      id: 'mg-mailbox',
    }

    const handedOn: unknown[] = []
    for (const sample of [policy, mailbox]) {
      const { rawBody, headers } = signedPost(sample)
      const delivery = await build().receiveWebhook!(rawBody, headers)
      handedOn.push(delivery.events.map((e) => [e.payload['recipient'], e.payload['bounce']]))
    }

    expect(handedOn).toEqual([[[policy.recipient, 'soft']], [[mailbox.recipient, 'hard']]])
  })
})
