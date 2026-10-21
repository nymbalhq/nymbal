import type { SearchDocument } from '@nymbalhq/types'

// The search suite's oracle: one tokeniser, for query, index and expectation. A term is a maximal run of ASCII letters
// and digits after lowercasing; everything else separates terms. A product matches a query iff the query has a term
// and every query term is a prefix of one of the product's terms in name, SKU, variant name or description. Nothing
// else it carries (slug, status, prices, category ids) is searched.

/** The terms of a text, as search sees them. */
export function searchTerms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** A product as the search handler indexes it, before it is a SearchDocument. */
export interface ContractProduct {
  id: string
  name: string
  description: string
  variants: Array<{ sku: string; name: string; priceMinor: number }>
  categoryIds: string[]
}

/** The document the search handler indexes for the product. */
export function toSearchDocument(p: ContractProduct): SearchDocument {
  return {
    id: p.id,
    type: 'product',
    fields: {
      slug: p.id,
      name: p.name,
      description: p.description,
      status: 'active',
      categoryIds: p.categoryIds,
      variants: p.variants.map((v) => ({ sku: v.sku, name: v.name, priceMinor: v.priceMinor })),
    },
  }
}

function prefixed(queryTerms: string[], docTerms: string[]): boolean {
  return queryTerms.every((q) => docTerms.some((d) => d.startsWith(q)))
}

function strongTerms(p: ContractProduct): string[] {
  return [
    ...searchTerms(p.name),
    ...p.variants.flatMap((v) => [...searchTerms(v.sku), ...searchTerms(v.name)]),
  ]
}

/** Does the product match the query. */
export function matchesQuery(p: ContractProduct, query: string): boolean {
  const q = searchTerms(query)
  return q.length > 0 && prefixed(q, [...strongTerms(p), ...searchTerms(p.description)])
}

/** 2: every term matches in the name; 1: every term matches in name, SKU or variant name; 0: otherwise. */
export function tierOf(p: ContractProduct, query: string): number {
  const q = searchTerms(query)
  if (prefixed(q, searchTerms(p.name))) return 2
  if (prefixed(q, strongTerms(p))) return 1
  return 0
}
