import { runEmailFeedbackContract, runWebhookContract } from '@nymbalhq/contract-tests'
import {
  complaint,
  createTestMailAdapter,
  formDelivery,
  hardBounce,
  jsonDelivery,
  softBounce,
  tampered,
  textDelivery,
} from '../../packages/platform/tests/support/test-mail'

// The email feedback contract and the webhook contract on the kernel's test email provider, in each of its three
// encodings: a hard bounce as a form post, a soft bounce as JSON, and a complaint as an SNS-style text notification.

const AT = new Date('2026-10-29T12:00:00.000Z')
const HARD = 'hard@contracts.test'
const SOFT = 'soft@contracts.test'
const COMPLAINT = 'complaint@contracts.test'

runEmailFeedbackContract('test-mail', () => createTestMailAdapter(), {
  bounce: () => ({ request: formDelivery('dlv_hard', hardBounce(HARD, AT)), recipient: HARD }),
  softBounce: () => ({
    request: jsonDelivery({ id: 'dlv_soft', events: [softBounce(SOFT, AT)] }),
    recipient: SOFT,
  }),
  complaint: () => ({
    request: textDelivery('dlv_complaint', complaint(COMPLAINT, AT)),
    recipient: COMPLAINT,
  }),
})

const delivery = () =>
  jsonDelivery({ id: 'dlv_contracts', events: [hardBounce(HARD, AT), complaint(COMPLAINT, AT)] })

runWebhookContract('test-mail', () => createTestMailAdapter(), {
  delivery,
  tampered: () => tampered(delivery()),
})
