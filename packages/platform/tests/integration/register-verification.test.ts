import { createKernel } from '../support/kernel.js'
import { registerVerificationSuite } from '../support/suites/register-verification.js'

// Sign-up with a confirmation link on SQLite: the uniform answer, the link, its single use, the account-exists notice,
// the resend, the reset and the admin's rescue, and the mail-health funnel.

registerVerificationSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 6,
})
