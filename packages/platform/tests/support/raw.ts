import Database from 'better-sqlite3'
import pg from 'pg'
import type { Dialect } from './kernel.js'

// A second connection to the kernel's database: committed state, read without the kernel's store, repositories or
// transaction context. SQL is written with `?` placeholders; Postgres gets them renumbered to `$n`.

export interface RawReader {
  rows<T>(sql: string, params?: unknown[]): Promise<T[]>
  one<T>(sql: string, params?: unknown[]): Promise<T>
  count(table: string, where?: string, params?: unknown[]): Promise<number>
  close(): Promise<void>
}

function positional(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${(n += 1)}`)
}

export function openRaw(dialect: Dialect, target: string): RawReader {
  const pool =
    dialect === 'postgres' ? new pg.Pool({ connectionString: target, max: 2 }) : undefined

  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (pool !== undefined) {
      const result = await pool.query(positional(sql), params)
      return result.rows as T[]
    }
    // A fresh read-only connection per query: it sees only what the kernel's connection has committed (WAL).
    const db = new Database(target, { readonly: true, fileMustExist: true })
    try {
      return db.prepare(sql).all(...params) as T[]
    } finally {
      db.close()
    }
  }

  return {
    rows,
    async one<T>(sql, params) {
      const [row] = await rows<T>(sql, params)
      if (row === undefined) throw new Error(`no row for: ${sql}`)
      return row
    },
    async count(table, where, params = []) {
      const sql = `SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`
      const [row] = await rows<{ n: number | string }>(sql, params)
      return Number(row!.n)
    },
    async close() {
      await pool?.end()
    },
  }
}

/** The stock column of one variant, as a second connection sees it. */
export async function stockOf(raw: RawReader, variantId: string): Promise<number> {
  const row = await raw.one<{ stock: number }>('SELECT stock FROM variants WHERE id = ?', [
    variantId,
  ])
  return Number(row.stock)
}
