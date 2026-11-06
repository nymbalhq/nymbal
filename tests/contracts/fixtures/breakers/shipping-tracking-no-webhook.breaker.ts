import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares tracking but takes no webhook, so nothing it registers ever reports back, must fail
// the words case, and only it.
runShippingContract('test-ship, tracking without receiveWebhook', () =>
  createTestShipAdapter({ hooked: false }),
)
