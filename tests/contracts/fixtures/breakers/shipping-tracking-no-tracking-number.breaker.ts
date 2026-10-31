import { runShippingTrackingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'
import { shippingTrackingOptions } from './shipping-tracking-deliveries'

// The control's twin that hands on, beside each event, a copy with no tracking number: declared, versioned and in its
// own namespace, so the kernel's event rule passes it and only the tracking rule refuses it. The correct event is still
// there, so it must fail the shape case, and only it.
runShippingTrackingContract(
  'test-ship, a numberless copy',
  () => createTestShipAdapter({ numberlessCopy: true }),
  shippingTrackingOptions,
)
