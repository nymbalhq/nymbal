import { createKernel } from '../support/kernel.js'
import { deliveryMarkerSuite } from '../support/suites/delivery-marker.js'

// AC-3 on the in-process bus, through createApp. The Redis Streams run is tests/primitives/delivery-marker.test.ts.
// In-process has no publish timeout: a stalled create would never resolve, so the bound is a deadline.

deliveryMarkerSuite('in-process', () => createKernel({ dialect: 'sqlite' }), 5_000)
