import type { SearchDocument } from '@nymbalhq/types'

/** The longest term the adapter stores or sends, in characters: a run token and one capped term stay under 512. */
export const MAX_TERM = 480
/** Algolia's limit on a query, in bytes. */
export const QUERY_LIMIT_BYTES = 512
/** Algolia's free-plan limit on a record, in bytes of its JSON (10 KB, counted low). */
export const RECORD_LIMIT_BYTES = 10_000

/** Native search's tokeniser: a term is a maximal run of ASCII letters and digits after lowercasing. */
export function searchTerms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

const capped = (terms: string[]): string[] => [...new Set(terms.map((t) => t.slice(0, MAX_TERM)))]

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A record as the index holds it: what the storefront reads (`fields.slug`), the terms searched and the facet. */
export interface AlgoliaRecord {
  objectID: string
  type: string
  fields: { slug?: unknown; name?: unknown; status?: unknown; categoryIds: string[] }
  _terms: string
  categoryIds: string[]
}

/** The document's terms in native's order (name, each variant's SKU and name, description), capped, first kept. */
export function documentTerms(doc: SearchDocument): string[] {
  const { fields } = doc
  const variants = Array.isArray(fields['variants'])
    ? (fields['variants'] as unknown[]).filter(
        (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      )
    : []
  return capped([
    ...searchTerms(textOf(fields['name'])),
    ...variants.flatMap((v) => [
      ...searchTerms(textOf(v['sku'])),
      ...searchTerms(textOf(v['name'])),
    ]),
    ...searchTerms(textOf(fields['description'])),
  ])
}

export function categoryIdsOf(doc: SearchDocument): string[] {
  const value = doc.fields['categoryIds']
  return Array.isArray(value)
    ? [...new Set((value as unknown[]).filter((c): c is string => typeof c === 'string'))]
    : []
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * The document's record, and how many trailing terms were dropped to keep it within RECORD_LIMIT_BYTES. Terms are
 * ASCII letters and digits, so each costs its length plus a separating space in the JSON.
 */
export function toRecord(doc: SearchDocument): { record: AlgoliaRecord; dropped: number } {
  const categoryIds = categoryIdsOf(doc)
  const { slug, name, status } = doc.fields
  const terms = documentTerms(doc)
  const record: AlgoliaRecord = {
    objectID: doc.id,
    type: doc.type,
    fields: { slug, name, status, categoryIds },
    _terms: '',
    categoryIds,
  }
  let size = jsonBytes(record)
  let kept = 0
  for (const term of terms) {
    const cost = term.length + (kept === 0 ? 0 : 1)
    if (size + cost > RECORD_LIMIT_BYTES) break
    size += cost
    kept += 1
  }
  record._terms = terms.slice(0, kept).join(' ')
  return { record, dropped: terms.length - kept }
}

/** The query Algolia is sent: its capped terms, deduplicated, as many leading ones as fit in QUERY_LIMIT_BYTES. */
export function queryText(query: string): string {
  let text = ''
  for (const term of capped(searchTerms(query))) {
    const next = text === '' ? term : `${text} ${term}`
    if (next.length > QUERY_LIMIT_BYTES) break
    text = next
  }
  return text
}
