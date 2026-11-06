import { createKernel } from '../support/kernel.js'
import { cartSignInSuite } from '../support/suites/cart-sign-in.js'

// AC-2, AC-5, AC-9 and AC-10 on SQLite, over HTTP on a served kernel.

cartSignInSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), {
  propertyRuns: 10,
  raceRounds: 6,
})
