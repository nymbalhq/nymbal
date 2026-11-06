import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that declares a word the shipping slot does not have must fail the words case, and only it.
runShippingContract('test-ship, an unknown word', () =>
  createTestShipAdapter({ words: ['rates', 'labels', 'tracking', 'webhooks'] }),
)
