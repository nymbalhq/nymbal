import type { NymbalConfig } from '@nymbal/config'
import { envOptional } from '@nymbal/config'
import { ConfigError } from '@nymbal/types'

import BetterSqlite3 from 'better-sqlite3'
import pg from 'pg'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import * as sqliteSchema from './schema/sqlite.js'
import * as postgresSchema from './schema/postgres.js'

export type SqliteClient = BetterSQLite3Database<typeof sqliteSchema>
export type PostgresClient = NodePgDatabase<typeof postgresSchema>

export type CommandStore =
  | { kind: 'sqlite'; db: SqliteClient; raw: BetterSqlite3.Database; close(): Promise<void>; transaction<T>(fn: (tx: SqliteClient) => Promise<T> | T): Promise<T> }
  | { kind: 'postgres'; db: PostgresClient; pool: pg.Pool; close(): Promise<void>; transaction<T>(fn: (tx: PostgresClient) => Promise<T> | T): Promise<T> }

export interface CommandStoreOptions {
  sqlitePath?: string
  postgresUrl?: string
}

export function createCommandStore(
  config: NymbalConfig,
  options: CommandStoreOptions = {},
): CommandStore {
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = options.sqlitePath ?? envOptional('NYMBAL_SQLITE_PATH') ?? './nymbal.db'
    const raw = new BetterSqlite3(path)
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')
    const db = drizzleSqlite(raw, { schema: sqliteSchema })
    return {
      kind: 'sqlite',
      db,
      raw,
      async close() {
        raw.close()
      },
      async transaction(fn) {
        // better-sqlite3 is synchronous — attempting an async tx with
        // Drizzle's sync wrapper causes the callback to resolve after the
        // transaction has already committed/rolled back. For v0.1 we run the
        // callback directly against the single connection; sqlite guarantees
        // serial access so the ACID boundary collapses to "the whole process".
        return fn(db)
      },
    }
  }

  if (config.infrastructure.commandStore === 'postgres') {
    const connectionString = options.postgresUrl ?? envOptional('DATABASE_URL')
    if (!connectionString) {
      throw new ConfigError(
        'commandStore=postgres requires DATABASE_URL to be set (or pass postgresUrl option).',
        { context: { commandStore: 'postgres' } },
      )
    }
    const pool = new pg.Pool({ connectionString })
    const db = drizzlePg(pool, { schema: postgresSchema })
    return {
      kind: 'postgres',
      db,
      pool,
      async close() {
        await pool.end()
      },
      async transaction(fn) {
        return db.transaction(async (tx) => fn(tx as unknown as PostgresClient))
      },
    }
  }

  throw new ConfigError(
    `Unsupported commandStore: ${String(config.infrastructure.commandStore)}`,
    { context: { commandStore: config.infrastructure.commandStore } },
  )
}
