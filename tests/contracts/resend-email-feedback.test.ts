import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createResendEmailAdapter } from '../../packages/adapters/email/resend/src/index.js'
import {
  bounced,
  changeOneCharacter,
  complained,
  RESEND_TEST_SECRET,
  signedPost,
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
})

const delivery = (): ResendRequest => signedPost(hardBounce, { id: 'msg_delivery' })

/** The delivery with one byte of the recipient changed after signing. */
const tampered = (): ResendRequest => {
  const real = delivery()
  const body = real.rawBody.toString('utf8')
  return { ...real, rawBody: Buffer.from(changeOneCharacter(body, body.indexOf(HARD)), 'utf8') }
}

runWebhookContract('resend', build, { delivery, tampered })
