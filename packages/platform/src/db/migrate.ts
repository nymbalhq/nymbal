import { resolve } from 'node:path'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator'
import { rawClients, type CommandStore } from './command-store.js'

export interface MigrateOptions {
  migrationsRoot?: string
}

export async function runMigrations(
  store: CommandStore,
  options: MigrateOptions = {},
): Promise<void> {
  const root = options.migrationsRoot ?? resolve(process.cwd(), 'migrations')
  const clients = rawClients(store)
  if (clients.kind === 'sqlite') {
    migrateSqlite(clients.db, { migrationsFolder: resolve(root, 'sqlite') })
  } else {
    await migratePostgres(clients.db, { migrationsFolder: resolve(root, 'postgres') })
  }
}
