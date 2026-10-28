import { runWebhookContract } from '@nymbalhq/contract-tests'
import { createTestHooksAdapter } from '../../../../packages/platform/tests/support/test-hooks'
import { webhookOptions } from './webhook-deliveries'

// The control's twin that hands on its events as the kernel's `payment.captured.v1`, declared in its producesEvents
// so that only the prefix is wrong, must fail the namespace case, and only it.
runWebhookContract(
  'test-hooks, a kernel type',
  () =>
    createTestHooksAdapter({
      rewriteType: 'payment.captured.v1',
      producesEvents: ['payment.captured.v1'],
    }),
  webhookOptions,
)
