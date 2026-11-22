import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin whose rates name no service must fail the rates shape case, and only it.
runShippingContract('test-ship, no service', () => createTestShipAdapter({ serviceOf: () => '' }))
