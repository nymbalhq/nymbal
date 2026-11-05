import { runShippingContract } from '@nymbalhq/contract-tests'
import { createNativeShippingAdapter, createLogger } from '@nymbalhq/platform'
import { createTestShipAdapter } from '../../packages/platform/tests/support/test-ship'

// The shipping suite on the kernel's native adapter, which declares no word and has none of the methods, and on the
// test shipping provider with all three words and their methods. The keyless and keyed EasyPost runs are in
// easypost-shipping.test.ts, AfterShip's in aftership-shipping.test.ts.

const logger = createLogger({ pretty: false, level: 'error' })
runShippingContract('native', () => createNativeShippingAdapter(logger))
runShippingContract('test-ship', () => createTestShipAdapter())
