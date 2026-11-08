import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { orderStatusMigrationSuite } from '../support/suites/order-status-migration.js'

// The order status data migration on Postgres, a fresh database per property run. Refuses to load without
// NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

orderStatusMigrationSuite(
  'postgres',
  async () => {
    const db = await createDatabase(serverUrl, 'status_migration')
    return { target: db.url, drop: () => db.drop() }
  },
  { runs: 6 },
)
