import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// A twin that sells labels without declaring rates, so no rate id can be had to buy one, must fail the words case, and
// only it.
runShippingContract('test-ship, labels without rates', () =>
  createTestShipAdapter({ words: ['labels', 'tracking'] }),
)
