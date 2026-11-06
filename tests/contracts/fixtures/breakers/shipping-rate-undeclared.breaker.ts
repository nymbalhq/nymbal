import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// A tracking-only twin that has a rate method it does not declare must fail the words case, and only it.
runShippingContract('test-ship, rate undeclared', () =>
  createTestShipAdapter({ words: ['tracking'], methods: ['rate', 'startTracking'] }),
)
