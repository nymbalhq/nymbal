import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { cartSignInSuite } from '../support/suites/cart-sign-in.js'

// AC-2, AC-5, AC-9 and AC-10 on Postgres (READ COMMITTED: the ceiling and the merge need the cart's row lock), in a
// fresh database for this file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

cartSignInSuite(
  'postgres',
  async () => {
    db = await createDatabase(serverUrl, 'cart_sign_in')
    return createKernel({ dialect: 'postgres', postgresUrl: db.url })
  },
  { propertyRuns: 8, raceRounds: 12 },
)
