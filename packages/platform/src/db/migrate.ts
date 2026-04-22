import { resolve } from 'node:path'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator'
import type { CommandStore } from './command-store.js'

export interface MigrateOptions {
  migrationsRoot?: string
}

export async function runMigrations(
  store: CommandStore,
  options: MigrateOptions = {},
): Promise<void> {
  const root = options.migrationsRoot ?? resolve(process.cwd(), 'migrations')
  if (store.kind === 'sqlite') {
    migrateSqlite(store.db, { migrationsFolder: resolve(root, 'sqlite') })
  } else {
    await migratePostgres(store.db, { migrationsFolder: resolve(root, 'postgres') })
  }
}
