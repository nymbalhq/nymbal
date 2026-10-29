import { runEmailFeedbackContract } from '@nymbalhq/contract-tests'
import { createTestMailAdapter } from '../../../../packages/platform/tests/support/test-mail'
import { emailFeedbackOptions } from './email-feedback-deliveries'

// The control for the email feedback breakers: the test email provider, correct, passes every case of the suite.
runEmailFeedbackContract('test-mail', () => createTestMailAdapter(), emailFeedbackOptions)
