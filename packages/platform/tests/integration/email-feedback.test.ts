import { createKernel } from '../support/kernel.js'
import { emailFeedbackSuite } from '../support/suites/email-feedback.js'

// Email bounce and complaint webhooks on SQLite; Postgres runs the same suite, its concurrent replays truly
// overlapping.

emailFeedbackSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 20,
})
