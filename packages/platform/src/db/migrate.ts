import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator'
import { rawClients, type CommandStore } from './command-store.js'

export interface MigrateOptions {
  migrationsRoot?: string
}

function rootOf(options: MigrateOptions): string {
  return options.migrationsRoot ?? resolve(process.cwd(), 'migrations')
}

export async function runMigrations(
  store: CommandStore,
  options: MigrateOptions = {},
): Promise<void> {
  const root = rootOf(options)
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    migrateSqlite(clients.db, { migrationsFolder: resolve(root, 'sqlite') })
  } else {
    await migratePostgres(clients.db, { migrationsFolder: resolve(root, 'postgres') })
  }
}

export interface MigrationState {
  /** Rows in the store's migrations table. */
  applied: number
  /** Journal entries `runMigrations` would apply. */
  pending: number
}

/**
 * What `runMigrations` would do to `store`, read without writing. Drizzle applies every journal entry created after the
 * newest one its table records, so that is what counts as pending; a store with no table has every entry pending.
 */
export async function migrationState(
  store: CommandStore,
  options: MigrateOptions = {},
): Promise<MigrationState> {
  const clients = rawClients(store)
  const journal = JSON.parse(
    readFileSync(resolve(rootOf(options), clients.kind, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ when: number }> }
  let applied = 0
  let newest = Number.NEGATIVE_INFINITY
  if (clients.kind === 'sqlite') {
    const table = clients.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get()
    if (table !== undefined) {
      const row = clients.raw
        .prepare('SELECT count(*) AS n, max(created_at) AS last FROM __drizzle_migrations')
        .get() as { n: number; last: number | null }
      applied = row.n
      if (row.last !== null) newest = Number(row.last)
    }
  } else {
    const { rows } = await clients.pool.query<{ table: string | null }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table",
    )
    if (rows[0]?.table != null) {
      const counted = await clients.pool.query<{ n: number; last: string | null }>(
        'SELECT count(*)::int AS n, max(created_at)::text AS last FROM drizzle.__drizzle_migrations',
      )
      applied = counted.rows[0]?.n ?? 0
      const last = counted.rows[0]?.last ?? null
      if (last !== null) newest = Number(last)
    }
  }
  const pending = journal.entries.filter((entry) => entry.when > newest).length
  return { applied, pending }
}
