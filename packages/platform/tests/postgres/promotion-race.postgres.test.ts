import { afterAll } from 'vitest'
import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { promotionRaceSuite } from '../support/suites/promotion-race.js'

// AC-20 on Postgres, in a fresh database for this file: the proof that the promotion row lock holds. The file refuses
// to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()
let db: TestDatabase | undefined

promotionRaceSuite(async () => {
  db = await createDatabase(serverUrl, 'promotion_race')
  return createKernel({ dialect: 'postgres', postgresUrl: db.url })
})

afterAll(async () => {
  await db?.drop()
})
