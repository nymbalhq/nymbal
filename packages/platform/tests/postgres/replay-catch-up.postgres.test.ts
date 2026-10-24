import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { replayCatchUpSuite } from '../support/suites/replay-catch-up.js'

// AC-3 on Postgres: cases (a) and (b) and the failure report, on a fresh database for the file. Refuses to load
// without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

replayCatchUpSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'replay_catch_up')
    const kernel = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
    return { kernel, drop: () => db.drop() }
  },
  { runs: 6 },
)
