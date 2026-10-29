import { runShippingTrackingContract } from '@nymbalhq/contract-tests'
import { createTestShipAdapter } from '../../../../packages/platform/tests/support/test-ship'
import { shippingTrackingOptions } from './shipping-tracking-deliveries'

// The control for the shipping tracking breakers: the test shipping provider, correct, passes every case of the suite.
runShippingTrackingContract('test-ship', () => createTestShipAdapter(), shippingTrackingOptions)
