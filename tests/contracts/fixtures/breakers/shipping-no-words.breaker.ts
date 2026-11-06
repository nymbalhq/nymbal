import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// An adapter with no word and none of the methods (as native): no rates, labels or tracking case runs, and none fails.
runShippingContract('test-ship, no words', () => createTestShipAdapter({ words: [] }))
