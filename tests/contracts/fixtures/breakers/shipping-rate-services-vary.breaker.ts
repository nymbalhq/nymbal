import { runShippingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'

// The control's twin whose services carry the rate call's number, so no two calls name the same services, must fail
// the rates stability case, and only it.
runShippingContract('test-ship, services vary', () =>
  createTestShipAdapter({ serviceOf: (service, call) => `${service}-${call}` }),
)
