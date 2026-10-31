import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDatabase,
  postgresServerUrl,
  type TestDatabase,
} from '../../packages/platform/tests/support/postgres.js'
import {
  observeMigrationGate,
  storeConfig,
  storeProject,
  type StoreProject,
} from '../support/start.js'

// AC-3 on Postgres: the migration gate of `nymbal start`, as packages/cli/src/commands/start-migrations.test.ts proves
// it on SQLite, against a fresh database on the composed server (NYMBAL_TEST_POSTGRES_URL). Spawns the built CLI.

let db: TestDatabase
let project: StoreProject

beforeAll(async () => {
  db = await createDatabase(postgresServerUrl(), 'start_migrations')
  project = storeProject(storeConfig({ commandStore: 'postgres' }))
})

afterAll(async () => {
  project?.remove()
  await db?.drop()
})

describe('AC-3: the migration gate on Postgres', () => {
  it('AC-3: with two migrations pending start exits 1 naming `nymbal migrate` and the rows are unchanged; start --migrate applies them and serves; start then serves and nymbal migrate exits 0, both leaving the rows as they are', async () => {
    const gate = await observeMigrationGate('postgres', db.url, project, { DATABASE_URL: db.url })

    expect(gate.rowsPending).toBe(gate.journal - 2)
    expect(gate.refused.code, gate.refused.out).toBe(1)
    expect(gate.refused.out).toContain('nymbal migrate')
    expect(gate.refused.rows).toBe(gate.rowsPending)
    expect(gate.refused.storefrontStarted).toBe(0)
    expect(gate.migrated.rows).toBe(gate.journal)
    expect(gate.migrated.ready).toBe(200)
    expect(gate.migrated.exit).toBe(0)
    expect(gate.restarted.rows).toBe(gate.migrated.rows)
    expect(gate.restarted.ready).toBe(200)
    expect(gate.migrateAgain.code, gate.migrateAgain.out).toBe(0)
    expect(gate.migrateAgain.rows).toBe(gate.restarted.rows)
  }, 180_000)
})
