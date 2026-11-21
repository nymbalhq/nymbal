import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderStatusMigrationSuite } from '../support/suites/order-status-migration.js'

// The order status data migration on a SQLite file, a fresh one per property run.

orderStatusMigrationSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-migration-'))
    return {
      target: join(dir, 'store.sqlite'),
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { runs: 25 },
)
