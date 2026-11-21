import { createKernel } from '../support/kernel.js'
import { legacyPasswordsSuite } from '../support/suites/legacy-passwords.js'

// Imported WordPress password hashes on SQLite: first sign-ins racing each other, a reset, a sweep and a new import;
// a hash file against passwords set on Nymbal; and no hash leaving the server.

legacyPasswordsSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 6,
})
