import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { emailFeedbackOptions } from './email-feedback-deliveries'

// The control's twin whose producesEvents leaves out its bounce type, which the kernel's route refuses on every live
// bounce, must fail the shape case, and only it.
runEmailFeedbackContract(
  'test-mail, bounces undeclared',
  () => createTestMailAdapter({ producesEvents: ['test-mail.complained.v1'] }),
  emailFeedbackOptions,
)
