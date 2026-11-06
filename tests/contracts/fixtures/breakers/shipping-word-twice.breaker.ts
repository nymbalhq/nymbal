import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares one word twice must fail the words case, and only it.
runShippingContract('test-ship, a word twice', () =>
  createTestShipAdapter({ words: ['rates', 'labels', 'tracking', 'tracking'] }),
)
