import { runWebhookContract } from '@nymbalhq/contract-tests'
import { createTestHooksAdapter } from '../../../../packages/platform/tests/support/test-hooks'
import { webhookOptions } from './webhook-deliveries'

// The control's twin that mints a delivery id on every call (a provider retry looks new) must fail the idempotency
// case, and only it.
runWebhookContract(
  'test-hooks, an id per call',
  () => createTestHooksAdapter({ freshDeliveryId: true }),
  webhookOptions,
)
