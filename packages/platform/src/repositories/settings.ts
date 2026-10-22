import { and, asc, eq } from 'drizzle-orm'
import {
  postgresDb,
  sqliteDb,
  type CommandStore,
  type ReadTx,
  type StoreRepository,
  type Tx,
} from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'

/** A row of `settings`: a secret's ciphertext with its IV, tag and key id, or a non-secret's `plain` value. */
export interface SettingRow {
  slot: string
  path: string
  ciphertext: Buffer | null
  plain: string | null
  iv: Buffer | null
  tag: Buffer | null
  keyId: string | null
  updatedAt: Date
  updatedBy: string | null
}

export interface SettingsRepository extends StoreRepository {
  list(tx: ReadTx): Promise<SettingRow[]>
  get(tx: ReadTx, slot: string, path: string): Promise<SettingRow | undefined>
  /** Inserts the row, or replaces the one at its slot and path. */
  put(tx: Tx, row: SettingRow): Promise<void>
  /** Whether a row was there to delete. */
  delete(tx: Tx, slot: string, path: string): Promise<boolean>
  /** Every row, or those of one slot, or one path of it; how many went. */
  clear(tx: Tx, filter?: { slot?: string; path?: string }): Promise<number>
}

const bytes = (value: Uint8Array | null): Buffer | null =>
  value === null ? null : Buffer.from(value)

type SqliteRow = typeof sqliteSchema.settings.$inferSelect
type PostgresRow = typeof postgresSchema.settings.$inferSelect

function fromSqlite(row: SqliteRow): SettingRow {
  return {
    ...row,
    ciphertext: bytes(row.ciphertext),
    iv: bytes(row.iv),
    tag: bytes(row.tag),
    updatedAt: new Date(row.updatedAt),
  }
}

function fromPostgres(row: PostgresRow): SettingRow {
  return { ...row, ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), tag: bytes(row.tag) }
}

export function createSettingsRepository(store: CommandStore): SettingsRepository {
  const sqliteWhere = (filter: { slot?: string; path?: string }) =>
    and(
      filter.slot === undefined ? undefined : eq(sqliteSchema.settings.slot, filter.slot),
      filter.path === undefined ? undefined : eq(sqliteSchema.settings.path, filter.path),
    )
  const postgresWhere = (filter: { slot?: string; path?: string }) =>
    and(
      filter.slot === undefined ? undefined : eq(postgresSchema.settings.slot, filter.slot),
      filter.path === undefined ? undefined : eq(postgresSchema.settings.path, filter.path),
    )

  const clear = async (tx: Tx, filter: { slot?: string; path?: string } = {}): Promise<number> => {
    if (tx.kind === 'sqlite') {
      return sqliteDb(tx).delete(sqliteSchema.settings).where(sqliteWhere(filter)).run().changes
    }
    const result = await postgresDb(tx).delete(postgresSchema.settings).where(postgresWhere(filter))
    return result.rowCount ?? 0
  }

  return {
    store,
    async list(tx) {
      if (tx.kind === 'sqlite') {
        const t = sqliteSchema.settings
        return sqliteDb(tx).select().from(t).orderBy(asc(t.slot), asc(t.path)).all().map(fromSqlite)
      }
      const t = postgresSchema.settings
      const rows = await postgresDb(tx).select().from(t).orderBy(asc(t.slot), asc(t.path))
      return rows.map(fromPostgres)
    },
    async get(tx, slot, path) {
      if (tx.kind === 'sqlite') {
        const row = sqliteDb(tx)
          .select()
          .from(sqliteSchema.settings)
          .where(sqliteWhere({ slot, path }))
          .get()
        return row === undefined ? undefined : fromSqlite(row)
      }
      const [row] = await postgresDb(tx)
        .select()
        .from(postgresSchema.settings)
        .where(postgresWhere({ slot, path }))
      return row === undefined ? undefined : fromPostgres(row)
    },
    async put(tx, row) {
      if (tx.kind === 'sqlite') {
        const values = { ...row, updatedAt: row.updatedAt.toISOString() }
        sqliteDb(tx)
          .insert(sqliteSchema.settings)
          .values(values)
          .onConflictDoUpdate({
            target: [sqliteSchema.settings.slot, sqliteSchema.settings.path],
            set: values,
          })
          .run()
        return
      }
      await postgresDb(tx)
        .insert(postgresSchema.settings)
        .values(row)
        .onConflictDoUpdate({
          target: [postgresSchema.settings.slot, postgresSchema.settings.path],
          set: row,
        })
    },
    async delete(tx, slot, path) {
      return (await clear(tx, { slot, path })) > 0
    },
    clear,
  }
}
