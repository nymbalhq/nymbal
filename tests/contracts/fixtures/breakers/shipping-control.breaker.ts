import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control for the shipping breakers: the test shipping provider with all three words and their methods passes every
// case of the suite.
runShippingContract('test-ship', () => createTestShipAdapter())
