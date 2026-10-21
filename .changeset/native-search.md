---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

The `native` search provider is full-text search in the store's own database: SQLite FTS5 on a SQLite store, a
GIN-indexed `tsvector` on Postgres. Every match is reachable through cursor pages with an exact total.

- Migration 0007 creates the search tables (`search_documents`, and on SQLite its FTS5 index). Run
  `nymbal migrate`. A store that had products before 0007 indexes them on its next start, from the warm-up replay.
- `createNativeSearchAdapter({ sql, logger })` takes the command store's raw clients (`rawClients(store)`), not a
  document store. `BuildAdaptersDeps` takes `sql` in place of `documentStore`. The `search-index` document-store
  collection is no longer written.
- Results are ranked: products with every query term in the name come first, then products with every term in the
  name, a SKU or a variant name, then the rest by the engine's score, then by id.
- `search` pages by `cursor`. `nextCursor` is null on the last page, and `total` counts every match. A malformed
  cursor is an error, and a cursor past the last match is an empty last page. `encodeSearchCursor(offset)` is
  exported. `filters.categoryIds` narrows to a category, with filters applied as well as the query.
- `FacetParams.query` is new: `facet('categoryIds', { query, filters })` counts the query's matches per category.
- `GET /api/products/search` takes `category=<slug>` and answers `{ items, nextCursor, total, facets }`. `facets` is
  the category facet in the listing's shape (slug values, name labels) when search reports `facet` and the query
  matches. An unknown category gives no items and a total of 0. A malformed cursor is a 400.
- The SDK's `products.search(query, { limit, cursor, category })` returns `total` and `facets`. The search store
  gains `loadMore()` and `setCategory(slug | null)`, and `SearchState` gains `category`, `nextCursor` and `facets`.
  Its `total` is now the API's total, not the number of results loaded. `useSearch` exposes the same.
- `<nymbal-product-filter source="search">` (React: `ProductFilter source="search"`) renders the search's facets and
  narrows the search to the category chosen. Choosing the chosen category again clears it.
- Both templates' `/search` show the API's total (`search-total`), a Load more button (`search-load-more`) while
  pages remain, and the category filter when the search has facets. The filter writes `?category=` beside `?q`.

**Behaviour change in matching.** A query is split into terms: runs of ASCII letters and digits, lowercased.
Everything else separates terms, and that includes non-ASCII letters. Each term must be a prefix of a word in the
product's name, SKU, variant name or description. The old match was a substring anywhere in the product. So
`ool` no longer finds "wool", `foo.bar` finds products with words starting `foo` and `bar`, a query with no terms
finds nothing, and a match in a field other than these four (a slug, a price) no longer counts.
