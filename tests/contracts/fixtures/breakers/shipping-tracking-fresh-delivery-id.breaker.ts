import { runShippingTrackingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'
import { shippingTrackingOptions } from './shipping-tracking-deliveries'

// The control's twin that mints a delivery id on every call, so each carrier retry of a delivered update would be
// recorded and acted on again, must fail the replay case, and only it.
runShippingTrackingContract(
  'test-ship, an id per call',
  () => createTestShipAdapter({ freshDeliveryId: true }),
  shippingTrackingOptions,
)
