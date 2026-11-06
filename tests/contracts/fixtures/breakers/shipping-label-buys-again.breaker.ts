import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin that buys a new label, with a new tracking number, each time one rate id is bought must fail the
// labels cases, and only them.
runShippingContract('test-ship, buys again', () => createTestShipAdapter({ buysAgain: true }))
