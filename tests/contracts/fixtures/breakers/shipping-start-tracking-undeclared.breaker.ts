import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that has startTracking without declaring tracking must fail the words case, and only it.
runShippingContract('test-ship, startTracking undeclared', () =>
  createTestShipAdapter({
    words: ['rates', 'labels'],
    methods: ['rate', 'createLabel', 'startTracking'],
  }),
)
