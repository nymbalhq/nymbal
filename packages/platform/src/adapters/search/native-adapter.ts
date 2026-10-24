import {
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  ValidationError,
  type Facet,
  type IndexResult,
  type Logger,
  type SearchAdapter,
  type SearchDocument,
  type SearchResult,
} from '@nymbalhq/types'
import type { RawClients } from '../../db/command-store.js'
import { noopInitialize, okHealth } from '../base.js'
import { createPostgresSearchIndex } from './postgres-index.js'
import { createSqliteSearchIndex } from './sqlite-index.js'
import { searchTerms, toIndexRow, type SearchIndex } from './terms.js'

const DEFAULT_LIMIT = 20

/** The cursor for a page starting at `offset`. It encodes any number; `search` rejects one that is not an offset. */
export function encodeSearchCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeSearchCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const offset = Number(text)
  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(offset) ||
    encodeSearchCursor(offset) !== cursor
  ) {
    throw new ValidationError('malformed search cursor')
  }
  return offset
}

/** `filters.categoryIds` (one id or several, any of them); the only filter native supports. */
function categoryFilter(filters: Record<string, unknown> | undefined): string[] | null {
  const value = filters?.['categoryIds']
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return null
}

const uniqueTerms = (query: string) => [...new Set(searchTerms(query))]

function indexOn(sql: RawClients): SearchIndex {
  return sql.kind === 'sqlite'
    ? createSqliteSearchIndex(sql.raw)
    : createPostgresSearchIndex(sql.pool)
}

/** Every document the native index in this command store's database holds, by id: what a dry run compares. */
export function nativeIndexDocuments(sql: RawClients): Promise<SearchDocument[]> {
  return indexOn(sql).all()
}

/**
 * Full-text search in the command store's own database: FTS5 on SQLite, a GIN-indexed tsvector on Postgres. Both
 * match by `searchTerms` (every query term a prefix of a term in the name, a SKU, a variant name or the description)
 * and rank every-term-in-the-name matches first, then name/SKU/variant-name matches, then by the engine's score.
 */
export function createNativeSearchAdapter(deps: {
  sql: RawClients
  logger: Logger
}): SearchAdapter {
  const { sql, logger } = deps
  const index = indexOn(sql)

  return {
    kind: 'search',
    providerName: 'native',
    capabilities: () => ['index', 'search', 'facet'],
    producesEvents: [],
    consumesEvents: [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED, EVT_PRODUCT_DELETED],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),

    async index(documents) {
      await index.upsert(documents.map(toIndexRow))
      logger.debug({ count: documents.length }, 'search.index')
      return { indexed: documents.length } satisfies IndexResult
    },

    async remove(ids) {
      await index.remove(ids)
    },

    async replaceAll(documents) {
      const rows = []
      for await (const doc of documents) rows.push(toIndexRow(doc))
      await index.replace(rows)
      logger.debug({ count: rows.length }, 'search.replaceAll')
    },

    async search(query, params) {
      const offset = params?.cursor === undefined ? 0 : decodeSearchCursor(params.cursor)
      const requested = params?.limit ?? DEFAULT_LIMIT
      const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_LIMIT
      const terms = uniqueTerms(query)
      if (terms.length === 0) return { items: [], total: 0, nextCursor: null }
      const categories = categoryFilter(params?.filters)
      const page = await index.page(terms, categories, limit, offset)
      // A page past the last match has no rows to carry the total.
      const total = page.total ?? (await index.count(terms, categories))
      const end = offset + page.docs.length
      return {
        items: page.docs,
        total,
        nextCursor: page.docs.length > 0 && end < total ? encodeSearchCursor(end) : null,
      } satisfies SearchResult
    },

    async facet(field, params) {
      const label = field === 'categoryIds' ? 'Category' : field
      if (field !== 'categoryIds') return { field, label, values: [] }
      const terms = params?.query === undefined ? null : uniqueTerms(params.query)
      if (terms !== null && terms.length === 0) return { field, label, values: [] }
      const values = await index.categoryCounts(
        terms,
        categoryFilter(params?.filters),
        params?.limit ?? null,
      )
      return { field, label, values } satisfies Facet
    },
  }
}
