import type pg from 'pg'
import type { SearchDocument } from '@nymbalhq/types'
import { latestById, type IndexRow, type QueryTerms, type SearchIndex } from './terms.js'

// Migration 0007: `search_documents` with a GIN-indexed `tsv`. The adapter writes `tsv` and the tsquery as literals
// of its own terms, so no text goes through a parser or dictionary: the 'simple' configuration's tokens, without its
// parser's splits.

/** Postgres's limits on a lexeme's bytes, a position's value and the positions kept per lexeme. */
const MAX_LEXEME = 2047
const MAX_POSITION = 16383
const MAX_POSITIONS = 256

const lexeme = (term: string) => term.slice(0, MAX_LEXEME)

/** The row's terms as a tsvector literal: name at weight A, SKU and variant name at B, description at C. */
function tsvectorLiteral(row: IndexRow): string {
  const positions = new Map<string, string[]>()
  let position = 0
  const add = (terms: string[], weight: 'A' | 'B' | 'C') => {
    for (const term of terms) {
      position = Math.min(position + 1, MAX_POSITION)
      const key = lexeme(term)
      const list = positions.get(key) ?? []
      if (list.length < MAX_POSITIONS) list.push(`${position}${weight}`)
      positions.set(key, list)
    }
  }
  add(row.name, 'A')
  add(row.strong, 'B')
  add(row.body, 'C')
  // The terms are [a-z0-9]+: quoting is all the escaping a lexeme needs.
  return [...positions].map(([key, list]) => `'${key}':${list.join(',')}`).join(' ')
}

/** Every term as a prefix, AND, restricted to the given weights ('' for any). */
function tsqueryLiteral(terms: QueryTerms, weights: '' | 'A' | 'AB'): string {
  return terms.map((t) => `'${lexeme(t)}':*${weights}`).join(' & ')
}

const IN_CATEGORY = `($2::text[] IS NULL OR category_ids && $2::text[])`

const SQL = {
  upsert: `INSERT INTO search_documents (id, type, fields, category_ids, tsv)
    SELECT r.id, r.type, r.fields, ARRAY(SELECT jsonb_array_elements_text(r.cats)), r.tsv::tsvector
    FROM jsonb_to_recordset($1::jsonb) AS r(id text, type text, fields jsonb, cats jsonb, tsv text)
    ON CONFLICT (id) DO UPDATE SET
      type = excluded.type, fields = excluded.fields, category_ids = excluded.category_ids, tsv = excluded.tsv
    WHERE search_documents.type IS DISTINCT FROM excluded.type
       OR search_documents.fields IS DISTINCT FROM excluded.fields`,
  remove: `DELETE FROM search_documents WHERE id = ANY($1::text[])`,
  // Rank: every term in the name, then every term in name, SKU or variant name, then ts_rank, then id.
  page: `SELECT id, type, fields, (count(*) OVER ())::int AS total
    FROM search_documents
    WHERE tsv @@ $1::tsquery AND ${IN_CATEGORY}
    ORDER BY tsv @@ $3::tsquery DESC, tsv @@ $4::tsquery DESC, ts_rank(tsv, $1::tsquery) DESC, id COLLATE "C"
    LIMIT $5 OFFSET $6`,
  count: `SELECT count(*)::int AS total FROM search_documents WHERE tsv @@ $1::tsquery AND ${IN_CATEGORY}`,
  facet: `SELECT c AS value, count(*)::int AS count
    FROM search_documents, unnest(category_ids) AS c
    WHERE ($1::tsquery IS NULL OR tsv @@ $1::tsquery) AND ${IN_CATEGORY}
    GROUP BY c ORDER BY count DESC, c COLLATE "C" LIMIT $3`,
} as const

export function createPostgresSearchIndex(pool: pg.Pool): SearchIndex {
  return {
    async upsert(rows) {
      const batch = latestById(rows).map((row) => ({
        id: row.id,
        type: row.type,
        fields: row.fields,
        cats: row.categoryIds,
        tsv: tsvectorLiteral(row),
      }))
      if (batch.length > 0) await pool.query(SQL.upsert, [JSON.stringify(batch)])
    },

    async remove(ids) {
      if (ids.length > 0) await pool.query(SQL.remove, [ids])
    },

    async page(terms, categories, limit, offset) {
      const result = await pool.query<SearchDocument & { total: number }>(SQL.page, [
        tsqueryLiteral(terms, ''),
        categories,
        tsqueryLiteral(terms, 'A'),
        tsqueryLiteral(terms, 'AB'),
        limit,
        offset,
      ])
      const docs = result.rows.map(({ id, type, fields }) => ({ id, type, fields }))
      return { docs, total: result.rows[0]?.total ?? null }
    },

    async count(terms, categories) {
      const result = await pool.query<{ total: number }>(SQL.count, [
        tsqueryLiteral(terms, ''),
        categories,
      ])
      return result.rows[0]!.total
    },

    async categoryCounts(terms, categories, limit) {
      const result = await pool.query<{ value: string; count: number }>(SQL.facet, [
        terms === null ? null : tsqueryLiteral(terms, ''),
        categories,
        limit,
      ])
      return result.rows
    },
  }
}
