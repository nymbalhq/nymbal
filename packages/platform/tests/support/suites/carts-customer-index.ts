import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { kernelConfig, MIGRATIONS_ROOT, type Dialect } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'

// A fresh database migrated to the head carries `carts_customer_idx` on carts(customer_id), partial on
// `customer_id IS NOT NULL`, and the sign-in's lookup of a customer's cart is planned on it rather than a scan.

const INDEX = 'carts_customer_idx'
const LOOKUP = "SELECT token FROM carts WHERE customer_id = 'customer-1'"

interface Found {
  table: string
  columns: string[]
  predicate: string
}

async function indexOf(dialect: Dialect, raw: RawReader): Promise<Found | null> {
  if (dialect === 'sqlite') {
    const [row] = await raw.rows<{ tbl_name: string; sql: string }>(
      "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      [INDEX],
    )
    if (row === undefined) return null
    const columns = await raw.rows<{ name: string }>(`PRAGMA index_info('${INDEX}')`)
    return {
      table: row.tbl_name,
      columns: columns.map((c) => c.name),
      predicate: /\bwhere\b(.*)$/is.exec(row.sql)?.[1]?.trim() ?? '',
    }
  }
  const [row] = await raw.rows<{ table: string; predicate: string | null }>(
    `SELECT t.relname AS table, pg_get_expr(ix.indpred, ix.indrelid) AS predicate
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
      WHERE i.relname = ?`,
    [INDEX],
  )
  if (row === undefined) return null
  const columns = await raw.rows<{ name: string }>(
    `SELECT a.attname AS name
       FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
      WHERE i.relname = ?`,
    [INDEX],
  )
  return { table: row.table, columns: columns.map((c) => c.name), predicate: row.predicate ?? '' }
}

/** The plan of the customer lookup, as text. Postgres is told not to scan, so an empty table still shows the index. */
async function lookupPlan(dialect: Dialect, target: string, raw: RawReader): Promise<string> {
  if (dialect === 'sqlite') {
    const rows = await raw.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${LOOKUP}`)
    return rows.map((r) => r.detail).join('\n')
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    await client.query('SET enable_seqscan = off')
    const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${LOOKUP}`)
    return result.rows.map((r) => r['QUERY PLAN']).join('\n')
  } finally {
    await client.end()
  }
}

const indexesNamedIn = (plan: string): string[] => [
  ...new Set([...plan.matchAll(/\b(carts_\w+_idx)\b/g)].map((m) => m[1]!)),
]

export function cartsCustomerIndexSuite(
  dialect: Dialect,
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`the carts customer index (${dialect})`, () => {
    let target: string
    let drop: () => Promise<void>
    let raw: RawReader

    beforeAll(async () => {
      ;({ target, drop } = await fresh())
      const config = kernelConfig(dialect)
      const store = createCommandStore(
        config,
        dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target },
      )
      try {
        await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
      } finally {
        await store.close()
      }
      raw = openRaw(dialect, target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await drop?.()
    })

    // Kills: migration 0019 missing from this dialect's folder or journal, so the sign-in lookup scans carts.
    it(`AC-15: after runMigrations on a fresh database, carts_customer_idx is on carts(customer_id), partial on customer_id IS NOT NULL, and the customer lookup is planned on it (${dialect})`, async () => {
      const found = await indexOf(dialect, raw)

      expect(found, `${INDEX} after the head migration`).not.toBeNull()
      expect([found!.table, found!.columns]).toEqual(['carts', ['customer_id']])
      expect(found!.predicate).toMatch(/customer_id"?\)?\s+IS\s+NOT\s+NULL/i)
      expect(indexesNamedIn(await lookupPlan(dialect, target, raw))).toEqual([INDEX])
    })
  })
}
