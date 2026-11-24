import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { withPolicyRejection } from './email-feedback-deliveries'

// The control given a policy rejection sample: the test email provider hands it on soft, as a provider that reads a
// recipient server's refusal of the sender (5.7.x) right does, and passes every case of the suite.
runEmailFeedbackContract(
  'test-mail, a policy rejection handed on soft',
  () => createTestMailAdapter(),
  withPolicyRejection('soft'),
)
