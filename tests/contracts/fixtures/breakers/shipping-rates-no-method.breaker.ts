import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares rates without a rate method must fail the words case, and only it.
runShippingContract('test-ship, rates without rate', () =>
  createTestShipAdapter({ methods: ['createLabel', 'startTracking'] }),
)
