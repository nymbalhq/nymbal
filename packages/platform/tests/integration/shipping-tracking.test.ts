import { createKernel } from '../support/kernel.js'
import { shippingTrackingSuite } from '../support/suites/shipping-tracking.js'

// Shipping tracking webhooks on SQLite; Postgres runs the same suite, its concurrent replays and moves truly
// overlapping.

shippingTrackingSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 10,
})
