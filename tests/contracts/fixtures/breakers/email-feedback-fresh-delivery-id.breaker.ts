import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { emailFeedbackOptions } from './email-feedback-deliveries'

// The control's twin that mints a delivery id on every call, so each provider retry of a bounce would be recorded
// again, must fail the replay case, and only it.
runEmailFeedbackContract(
  'test-mail, an id per call',
  () => createTestMailAdapter({ freshDeliveryId: true }),
  emailFeedbackOptions,
)
