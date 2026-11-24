import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { withPolicyRejection } from './email-feedback-deliveries'

// The control's twin that hands the policy rejection on as a hard bounce, so a day on a blocklist would suppress the
// address for ever, must fail the policy rejection case, and only it.
runEmailFeedbackContract(
  'test-mail, a policy rejection handed on hard',
  () => createTestMailAdapter(),
  withPolicyRejection('hard'),
)
