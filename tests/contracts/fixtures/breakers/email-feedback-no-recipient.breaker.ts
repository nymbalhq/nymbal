import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { emailFeedbackOptions } from './email-feedback-deliveries'

// The control's twin that hands on, beside each event, a copy with no recipient: declared, versioned and in its own
// namespace, so the kernel's event rule passes it and only the feedback rule refuses it. It must fail the shape case,
// and only it.
runEmailFeedbackContract(
  'test-mail, a recipientless copy',
  () => createTestMailAdapter({ recipientlessCopy: true }),
  emailFeedbackOptions,
)
