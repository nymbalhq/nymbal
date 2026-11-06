import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares tracking without a startTracking method must fail the words case, and only it.
runShippingContract('test-ship, tracking without startTracking', () =>
  createTestShipAdapter({ methods: ['rate', 'createLabel'] }),
)
