import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { observeMigrationGate, storeConfig, storeProject } from '../../../../tests/support/start.js'

// AC-3 on SQLite: `nymbal start` refuses to serve over pending migrations and leaves the store as it was; `--migrate`
// applies them and serves; with none pending start serves and `nymbal migrate` exits 0. The Postgres half is
// tests/stores/start-migrations-postgres.test.ts. Spawns the built CLI (`pnpm build` first).

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

describe('AC-3: the migration gate on SQLite', () => {
  it('AC-3: with two migrations pending start exits 1 naming `nymbal migrate` and the rows are unchanged; start --migrate applies them and serves; start then serves and nymbal migrate exits 0, both leaving the rows as they are', async () => {
    const project = storeProject(storeConfig())
    cleanup.push(() => project.remove())
    const db = join(project.dir, 'shop.db')

    const gate = await observeMigrationGate('sqlite', db, project, { NYMBAL_SQLITE_PATH: db })

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
