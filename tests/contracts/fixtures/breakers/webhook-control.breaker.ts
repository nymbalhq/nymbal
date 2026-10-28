import { runWebhookContract } from '@nymbalhq/contract-tests'
import { createTestHooksAdapter } from '../../../../packages/platform/tests/support/test-hooks'
import { webhookOptions } from './webhook-deliveries'

// The control for the webhook breakers: the test provider, correct, passes every case of the published webhook suite.
runWebhookContract('test-hooks', () => createTestHooksAdapter(), webhookOptions)
