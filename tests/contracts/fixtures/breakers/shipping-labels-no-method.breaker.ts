import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares labels without a createLabel method must fail the words case, and only it.
runShippingContract('test-ship, labels without createLabel', () =>
  createTestShipAdapter({ methods: ['rate', 'startTracking'] }),
)
