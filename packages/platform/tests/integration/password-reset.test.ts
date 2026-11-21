import { createKernel } from '../support/kernel.js'
import { passwordResetSuite } from '../support/suites/password-reset.js'

// "Forgot password?" on SQLite: the request, the mail, the link and its single use (AC-7 to AC-17).

passwordResetSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 6,
})
