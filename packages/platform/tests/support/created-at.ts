import Database from 'better-sqlite3'
import pg from 'pg'
import type { Dialect } from './kernel.js'

// The `events` rows a sweep must judge, through a connection of its own: set a row's created_at (the log's `append`
// stamps every row with the time of the append), read every row's, and say which of some ids are still in the log.
// Typed for the root typecheck, which reaches it from tests/stores.

type Row = Record<string, unknown>

async function onPostgres<T>(target: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

function onSqlite<T>(target: string, fn: (db: Database.Database) => T): T {
  const db = new Database(target)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export async function setCreatedAt(
  dialect: Dialect,
  target: string,
  at: Map<string, Date>,
): Promise<void> {
  if (dialect === 'sqlite') {
    onSqlite(target, (db) => {
      const update = db.prepare('UPDATE events SET created_at = ? WHERE id = ?')
      for (const [id, date] of at) update.run(date.toISOString(), id)
    })
    return
  }
  await onPostgres(target, async (client) => {
    for (const [id, date] of at) {
      await client.query('UPDATE events SET created_at = $1 WHERE id = $2', [
        date.toISOString(),
        id,
      ])
    }
  })
}

/** Every row's created_at, by event id. */
export async function createdAtById(dialect: Dialect, target: string): Promise<Map<string, Date>> {
  const sql = 'SELECT id, created_at FROM events'
  const rows: Row[] =
    dialect === 'sqlite'
      ? onSqlite(target, (db) => db.prepare(sql).all() as Row[])
      : await onPostgres(target, async (client) => (await client.query(sql)).rows as Row[])
  return new Map(
    rows.map((r) => [String(r['id']), new Date(r['created_at'] as string | Date)] as const),
  )
}

/** Which of `ids` are still rows of the log. */
export async function presentIds(
  dialect: Dialect,
  target: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows: Row[] =
    dialect === 'sqlite'
      ? onSqlite(
          target,
          (db) =>
            db
              .prepare(`SELECT id FROM events WHERE id IN (${ids.map(() => '?').join(', ')})`)
              .all(...ids) as Row[],
        )
      : await onPostgres(
          target,
          async (client) =>
            (await client.query('SELECT id FROM events WHERE id = ANY($1)', [ids])).rows as Row[],
        )
  return new Set(rows.map((r) => String(r['id'])))
}
