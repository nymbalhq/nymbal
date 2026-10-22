import type BetterSqlite3 from 'better-sqlite3'
import type { SearchDocument } from '@nymbalhq/types'
import { sqliteTurn } from '../../db/command-store.js'
import { latestById, type IndexRow, type QueryTerms, type SearchIndex } from './terms.js'

// Migration 0007: `search_documents`, indexed by the external-content FTS5 table `search_documents_fts` over the
// name, strong (SKU and variant name) and body (description) terms.

/** Every term as a prefix, AND: the terms are [a-z0-9]+, so quoting them is all the escaping FTS5 needs. */
function matchAll(terms: QueryTerms): string {
  return terms.map((t) => `"${t}"*`).join(' AND ')
}

const IN_CATEGORY = `(@cats IS NULL OR EXISTS (
  SELECT 1 FROM json_each(d.category_ids) c WHERE c.value IN (SELECT value FROM json_each(@cats))))`

const matching = (score: boolean) => `hits AS MATERIALIZED (
  SELECT rowid AS rid${score ? ', bm25(search_documents_fts) AS score' : ''}
  FROM search_documents_fts WHERE search_documents_fts MATCH @all)`

const SQL = {
  upsert: `INSERT INTO search_documents (id, type, fields, category_ids, name_terms, strong_terms, body_terms)
    VALUES (@id, @type, @fields, @cats, @name, @strong, @body)
    ON CONFLICT (id) DO UPDATE SET
      type = excluded.type, fields = excluded.fields, category_ids = excluded.category_ids,
      name_terms = excluded.name_terms, strong_terms = excluded.strong_terms, body_terms = excluded.body_terms
    WHERE search_documents.type IS NOT excluded.type OR search_documents.fields IS NOT excluded.fields`,
  remove: `DELETE FROM search_documents WHERE id = ?`,
  clear: `DELETE FROM search_documents`,
  all: `SELECT id, type, fields FROM search_documents ORDER BY id`,
  // Rank: every term in the name, then every term in name, SKU or variant name, then bm25 (lower is better), then id.
  page: `WITH ${matching(true)},
    named AS MATERIALIZED (
      SELECT rowid AS rid FROM search_documents_fts WHERE search_documents_fts MATCH @name),
    strong AS MATERIALIZED (
      SELECT rowid AS rid FROM search_documents_fts WHERE search_documents_fts MATCH @strong)
    SELECT d.id, d.type, d.fields, count(*) OVER () AS total
    FROM hits h JOIN search_documents d ON d.rid = h.rid
    WHERE ${IN_CATEGORY}
    ORDER BY h.rid IN (SELECT rid FROM named) DESC, h.rid IN (SELECT rid FROM strong) DESC, h.score, d.id
    LIMIT @limit OFFSET @offset`,
  count: `WITH ${matching(false)}
    SELECT count(*) AS total FROM hits h JOIN search_documents d ON d.rid = h.rid WHERE ${IN_CATEGORY}`,
  facet: `WITH ${matching(false)}
    SELECT c.value AS value, count(*) AS count
    FROM hits h JOIN search_documents d ON d.rid = h.rid JOIN json_each(d.category_ids) c
    WHERE ${IN_CATEGORY}
    GROUP BY c.value ORDER BY count DESC, c.value LIMIT @limit`,
  facetAll: `SELECT c.value AS value, count(*) AS count
    FROM search_documents d JOIN json_each(d.category_ids) c
    WHERE ${IN_CATEGORY}
    GROUP BY c.value ORDER BY count DESC, c.value LIMIT @limit`,
} as const

interface PageRow {
  id: string
  type: string
  fields: string
  total: number
}

export function createSqliteSearchIndex(raw: BetterSqlite3.Database): SearchIndex {
  // Prepared on first use: the adapter can be built before migrations have created the tables.
  const prepared = new Map<keyof typeof SQL, BetterSqlite3.Statement>()
  const statement = (key: keyof typeof SQL) => {
    let stmt = prepared.get(key)
    if (stmt === undefined) {
      stmt = raw.prepare(SQL[key])
      prepared.set(key, stmt)
    }
    return stmt
  }
  const cats = (categories: string[] | null) =>
    categories === null ? null : JSON.stringify(categories)
  const queryParams = (terms: QueryTerms, categories: string[] | null) => ({
    all: matchAll(terms),
    cats: cats(categories),
  })

  const write = (rows: IndexRow[]) => {
    const upsert = statement('upsert')
    for (const row of latestById(rows)) {
      upsert.run({
        id: row.id,
        type: row.type,
        fields: JSON.stringify(row.fields),
        cats: JSON.stringify(row.categoryIds),
        name: row.name.join(' '),
        strong: row.strong.join(' '),
        body: row.body.join(' '),
      })
    }
  }

  return {
    upsert: (rows) => sqliteTurn(raw, () => raw.transaction(write)(rows)),

    replace: (rows) =>
      sqliteTurn(raw, () =>
        raw.transaction((batch: IndexRow[]) => {
          statement('clear').run()
          write(batch)
        })(rows),
      ),

    all: () =>
      sqliteTurn(raw, () =>
        (statement('all').all() as Array<Omit<PageRow, 'total'>>).map((r) => ({
          id: r.id,
          type: r.type,
          fields: JSON.parse(r.fields) as Record<string, unknown>,
        })),
      ),

    remove: (ids) =>
      sqliteTurn(raw, () => {
        const remove = statement('remove')
        raw.transaction((batch: string[]) => {
          for (const id of batch) remove.run(id)
        })(ids)
      }),

    page: (terms, categories, limit, offset) =>
      sqliteTurn(raw, () => {
        const all = matchAll(terms)
        const rows = statement('page').all({
          ...queryParams(terms, categories),
          name: `name_terms : (${all})`,
          strong: `{name_terms strong_terms} : (${all})`,
          limit,
          offset,
        }) as PageRow[]
        const docs: SearchDocument[] = rows.map((r) => ({
          id: r.id,
          type: r.type,
          fields: JSON.parse(r.fields) as Record<string, unknown>,
        }))
        return { docs, total: rows[0]?.total ?? null }
      }),

    count: (terms, categories) =>
      sqliteTurn(
        raw,
        () => (statement('count').get(queryParams(terms, categories)) as { total: number }).total,
      ),

    categoryCounts: (terms, categories, limit) =>
      sqliteTurn(raw, () => {
        const params = { cats: cats(categories), limit: limit ?? -1 }
        return (
          terms === null
            ? statement('facetAll').all(params)
            : statement('facet').all({ ...params, all: matchAll(terms) })
        ) as Array<{ value: string; count: number }>
      }),
  }
}
