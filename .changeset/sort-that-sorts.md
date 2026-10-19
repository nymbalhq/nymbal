---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/sdk': minor
'@nymbalhq/react': minor
'@nymbalhq/web-components': minor
create-nymbal-app: minor
---

Sort works. `GET /api/products?sort=` takes `newest` (the default), `price-asc`, `price-desc`, `name-asc` or `name-desc`, ties broken by slug; an unknown key, or a cursor from another sort, answers 400. Breaking in the SDK: `productList.setSort(key)` takes a `ProductSortKey` instead of `(field, direction)`, `state.sort` is that key, and `load`, `setSort` and `loadMore` keep the active sort and category. `QueryParams.orderBy` orders a document-store query without filtering it. Both templates offer the same five sorts, keep them in `?sort=`, and render that order on the server. Category facet counts on `GET /api/products` now always count the whole catalogue.
