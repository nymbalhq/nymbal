import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that has createLabel without declaring labels must fail the words case, and only it.
runShippingContract('test-ship, createLabel undeclared', () =>
  createTestShipAdapter({
    words: ['rates', 'tracking'],
    methods: ['rate', 'createLabel', 'startTracking'],
  }),
)
