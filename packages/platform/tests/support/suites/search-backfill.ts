import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { SearchAdapter } from '@nymbalhq/types'
import { createNativeSearchAdapter } from '../../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients } from '../../../src/db/command-store.js'
import { createLogger } from '../../../src/logger.js'
import { kernelConfig, type Kernel } from '../kernel.js'
import { queryOnce } from '../postgres.js'

// P2-07 AC-6 on one dialect (decision 2): the index is derivable. Products created by one kernel, the search tables
// migration 0007 created then emptied (as a store upgraded to 0007 starts: products, no index), and a new kernel on
// the same database answers search for every one of them, because warm-up replays product.created to the derived
// search handler. On that kernel an update re-indexes: the old name no longer matches, the new one does.
// Kills: an index fed only by new events (no backfill on start), and an update that appends a second row instead of
// replacing the first.

const logger = createLogger({ pretty: false, level: 'error' })
const PRODUCTS = 12

export interface ReopenableDatabase {
  /** A kernel on this database; each call is a fresh process's worth of state. */
  open(): Promise<Kernel>
  drop(): Promise<void>
}

/** Empties the search tables 0007 created and returns their names (none: there are no search tables). */
async function emptySearchTables(dialect: Kernel['dialect'], target: string): Promise<string[]> {
  if (dialect === 'sqlite') {
    const raw = new Database(target)
    try {
      const tables = raw
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string; sql: string | null }>
      const base = tables.filter((t) => t.name === 'search_documents').map((t) => t.name)
      const fts = tables
        .filter((t) => /^CREATE VIRTUAL TABLE[\s\S]*USING\s+fts5/i.test(t.sql ?? ''))
        .map((t) => t.name)
      // The base table first (its triggers, if any, delete from the FTS index), then the external-content index.
      for (const name of base) raw.prepare(`DELETE FROM "${name}"`).run()
      for (const name of fts)
        raw.prepare(`INSERT INTO "${name}"("${name}") VALUES ('delete-all')`).run()
      return [...base, ...fts]
    } finally {
      raw.close()
    }
  }
  const tables = await queryOnce<{ table_name: string }>(
    target,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'search%' AND table_type = 'BASE TABLE'`,
  )
  const names = tables.map((t) => t.table_name)
  if (names.length > 0) await queryOnce(target, `TRUNCATE ${names.map((n) => `"${n}"`).join(', ')}`)
  return names
}

async function idsFor(adapter: SearchAdapter, query: string): Promise<string[]> {
  return (await adapter.search(query, { limit: 100 })).items.map((d) => d.id).sort()
}

/** What the database's index answers with no kernel and no warm-up: a native adapter on a store of its own. */
async function idsWithoutWarmUp(
  dialect: Kernel['dialect'],
  target: string,
  query: string,
): Promise<string[]> {
  const storage = dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
  const store = createCommandStore(kernelConfig(dialect), storage)
  try {
    return await idsFor(createNativeSearchAdapter({ sql: rawClients(store), logger }), query)
  } finally {
    await store.close()
  }
}

export function searchBackfillSuite(
  dialect: Kernel['dialect'],
  fresh: () => Promise<ReopenableDatabase>,
): void {
  describe(`P2-07 AC-6: the search index is backfilled on start (${dialect})`, () => {
    it(`AC-6: products created before the search tables held them answer search after a restart, and an update re-indexes: the old name no longer matches, the new one does (${dialect})`, async () => {
      const db = await fresh()
      try {
        const token = `bf${randomUUID().replace(/-/g, '').slice(0, 12)}`
        // Only the name carries the token: decision 3 also matches SKUs, so a SKU holding it would keep the renamed
        // product matching and hide an index that appends the new name instead of replacing the old.
        const skuToken = `sk${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const ids: string[] = []
        const first = await db.open()
        const target = first.target
        try {
          for (let i = 0; i < PRODUCTS; i++) {
            const product = await first.services.product.create({
              slug: `p2-07-backfill-${token}-${i}`,
              name: `Backfill ${token} item${i}`,
              description: 'A product made before its store had a search index.',
              status: 'active',
              variants: [
                {
                  sku: `BF-${skuToken}-${i}`,
                  name: 'Default',
                  priceMinor: 1000,
                  stock: 1,
                  options: [],
                },
              ],
            })
            ids.push(product.id)
          }
        } finally {
          await first.close()
        }

        const emptied = await emptySearchTables(dialect, target)
        expect(emptied, 'the search tables migration 0007 creates').toContain('search_documents')
        expect(
          await idsWithoutWarmUp(dialect, target, token),
          'the emptied index still answers: the restart would prove nothing',
        ).toEqual([])

        const second = await db.open()
        try {
          const search = second.app.adapters.search
          expect(await idsFor(search, token), 'search after the restart').toEqual([...ids].sort())

          const renamed = `rn${randomUUID().replace(/-/g, '').slice(0, 12)}`
          await second.services.product.update(ids[0]!, { name: `Renamed ${renamed}` })
          expect(await idsFor(search, token), 'the old name after the update').toEqual(
            ids.slice(1).sort(),
          )
          expect(await idsFor(search, renamed), 'the new name after the update').toEqual([ids[0]!])
        } finally {
          await second.close()
        }
      } finally {
        await db.drop()
      }
    }, 60_000)
  })
}
