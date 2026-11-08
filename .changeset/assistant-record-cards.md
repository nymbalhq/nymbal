---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
'nymbal': minor
---

The admin's assistant shows a card for each order or customer it read, filled from the store, and sends order and product lists to the AI provider as summaries. `AssistantFrame` gains a `record` event.
`GET /api/admin/orders` filters by shipping `postcode` and `country` in the store's query and answers `meta.total`; `customer`, `q` and date filters now find orders of any age. MCP tool results of a paged list are `{ items, total }` or `{ items, nextCursor }`, where they were `{ items }`.
`nymbal eval assistant` asks 27 questions; its default threshold is 24.
