import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createMailgunEmailAdapter } from '../../packages/adapters/email/mailgun/src/index.js'
import {
  changeOneCharacter,
  complaint,
  MAILGUN_TEST_SIGNING_KEY,
  mailgunRequest,
  permanentFailure,
  signedBody,
  signedPost,
  temporaryFailure,
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
