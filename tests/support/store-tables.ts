import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// A SQLite command store's tables as a second, read-only connection sees them, for comparing a store with itself
// before and after a command row for row.

const BetterSqlite3 = createRequire(
  fileURLToPath(new URL('../../packages/platform/package.json', import.meta.url)),
)('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

/**
 * Tables an import's rollback cannot leave as they were, by design: the event log and the audit trail only grow, the
 * order sequence never rewinds (a number would be handed out twice), and the migrations' own bookkeeping.
 */
export const NOT_COVERED: ReadonlySet<string> = new Set([
  'events',
  'processed_events',
  'audit_entries',
  'order_sequences',
  '__drizzle_migrations',
])

/**
 * The native search index (`search_documents` and its FTS5 tables) is the search read model: every boot's rebuild
 * renumbers its rows, so it is compared as a read model, not as a table.
 */
export const isSearchIndex = (table: string): boolean => table.startsWith('search_documents')

/** Each table's rows, each row as JSON with its keys sorted, the rows sorted: equal snapshots hold equal rows. */
export type TableSnapshot = Record<string, string[]>

export function readRows<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

export function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((k) => {
          const v = row[k]
          return [k, v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v]
        }),
    ),
  )
}

export function tableSnapshot(dbPath: string, keep: (table: string) => boolean): TableSnapshot {
  const tables = readRows<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
    .map((t) => t.name)
    .filter(keep)
  return Object.fromEntries(
    tables.map((t) => [
      t,
      readRows<Record<string, unknown>>(dbPath, `SELECT * FROM "${t}"`).map(canonicalRow).sort(),
    ]),
  )
}

/** Every table a rollback must leave as it found it (the store's covered tables). */
export const coveredTables = (dbPath: string): TableSnapshot =>
  tableSnapshot(dbPath, (t) => !NOT_COVERED.has(t) && !isSearchIndex(t))

/** Every table but the search index's: what a command that is refused must not write to. */
export const everyTable = (dbPath: string): TableSnapshot =>
  tableSnapshot(dbPath, (t) => !isSearchIndex(t))

/** The tables whose rows differ between two snapshots. */
export function tablesThatDiffer(before: TableSnapshot, after: TableSnapshot): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return names.filter((t) => {
    const a = before[t] ?? []
    const b = after[t] ?? []
    return a.length !== b.length || a.some((row, i) => row !== b[i])
  })
}
