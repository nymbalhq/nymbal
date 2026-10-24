import { createKernel } from '../support/kernel.js'
import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { replayDeterminismSuite } from '../support/suites/replay-determinism.js'

// AC-2 on Postgres (the run gate:full makes): a fresh database per property run. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

replayDeterminismSuite('postgres', {
  runs: 4,
  async fresh() {
    const db = await createDatabase(serverUrl, 'replay_determinism')
    try {
      const kernel = await createKernel({ dialect: 'postgres', postgresUrl: db.url })
      return { kernel, drop: () => db.drop() }
    } catch (error) {
      await db.drop()
      throw error
    }
  },
})
