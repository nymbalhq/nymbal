import type { SearchDocument } from '@nymbalhq/types'

/**
 * The one tokeniser for queries and indexed text, on both dialects: a term is a maximal run of ASCII letters and
 * digits after lowercasing, and everything else separates terms. Only these terms reach FTS5 or a tsquery, so no
 * operator, quote or punctuation from input reaches either engine.
 */
export function searchTerms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** A document as the index stores it: its terms by tier, and the category ids it can be filtered and faceted by. */
export interface IndexRow {
  id: string
  type: string
  fields: Record<string, unknown>
  categoryIds: string[]
  /** The name's terms. */
  name: string[]
  /** Each variant's SKU and name terms. */
  strong: string[]
  /** The description's terms. */
  body: string[]
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

export function toIndexRow(doc: SearchDocument): IndexRow {
  const { fields } = doc
  const variants = Array.isArray(fields['variants'])
    ? (fields['variants'] as unknown[]).filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      )
    : []
  const categoryIds = Array.isArray(fields['categoryIds'])
    ? [...new Set((fields['categoryIds'] as unknown[]).filter((c) => typeof c === 'string'))]
    : []
  return {
    id: doc.id,
    type: doc.type,
    fields,
    categoryIds,
    name: searchTerms(textOf(fields['name'])),
    strong: variants.flatMap((v) => [
      ...searchTerms(textOf(v['sku'])),
      ...searchTerms(textOf(v['name'])),
    ]),
    body: searchTerms(textOf(fields['description'])),
  }
}

/** The last version of each id, so one batch writes each row once. */
export function latestById(rows: IndexRow[]): IndexRow[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

/** A query's terms, each a prefix every match must carry (AND), deduplicated. */
export type QueryTerms = readonly string[]

/** What one dialect's index answers; the adapter validates and normalises before it asks. */
export interface SearchIndex {
  upsert(rows: IndexRow[]): Promise<void>
  remove(ids: string[]): Promise<void>
  /** One page in rank order, and the match count when the page has rows. */
  page(
    terms: QueryTerms,
    categories: string[] | null,
    limit: number,
    offset: number,
  ): Promise<{ docs: SearchDocument[]; total: number | null }>
  count(terms: QueryTerms, categories: string[] | null): Promise<number>
  /** Per category id, the matches of `terms` (every document when null), count descending, then id. */
  categoryCounts(
    terms: QueryTerms | null,
    categories: string[] | null,
    limit: number | null,
  ): Promise<Array<{ value: string; count: number }>>
}
