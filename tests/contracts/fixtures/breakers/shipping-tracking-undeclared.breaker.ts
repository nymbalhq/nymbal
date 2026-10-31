import { runShippingTrackingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'
import { shippingTrackingOptions } from './shipping-tracking-deliveries'

// The control's twin whose producesEvents leaves out its tracking type, which the kernel's route refuses on every live
// update, must fail the shape case, and only it.
runShippingTrackingContract(
  'test-ship, tracking undeclared',
  () => createTestShipAdapter({ producesEvents: [] }),
  shippingTrackingOptions,
)
