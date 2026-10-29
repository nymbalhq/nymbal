import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import type { Logger } from '@nymbalhq/types'
import { createSesEmailAdapter } from '../../packages/adapter-ses/src/index.js'
import {
  changeOneCharacter,
  notification,
  SES_TEST_CERT_URL,
  SES_TEST_REGION,
  SES_TEST_TOPIC,
  sesBounce,
  sesComplaint,
  sesTestSigner,
  signedSnsPost,
  type SesRequest,
} from '../support/ses'

// The email feedback contract and the webhook contract on @nymbalhq/adapter-ses, with the test certificate injected
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

const post = (ses: object, messageId: string): SesRequest =>
  signedSnsPost(notification(ses, { messageId, timestamp: SNS_AT }))

runEmailFeedbackContract('ses', build, {
  bounce: () => ({ request: post(hardBounce, 'sns-hard'), recipient: HARD }),
  softBounce: () => ({ request: post(softBounce, 'sns-soft'), recipient: SOFT }),
  complaint: () => ({ request: post(complaint, 'sns-complaint'), recipient: COMPLAINT }),
})

const delivery = (): SesRequest => post(hardBounce, 'sns-delivery')

/** The delivery with one character of the recipient, inside the signed Message, changed after signing. */
const tampered = (): SesRequest => {
  const real = delivery()
  const body = real.rawBody.toString('utf8')
  return { ...real, rawBody: Buffer.from(changeOneCharacter(body, body.indexOf(HARD)), 'utf8') }
}

runWebhookContract('ses', build, { delivery, tampered })
