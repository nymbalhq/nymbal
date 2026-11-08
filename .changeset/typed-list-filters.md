---
'@nymbalhq/platform': minor
---

`GET /api/admin/orders`, `/api/admin/products` and `/api/admin/inventory` answer 400 `validation.failed` naming the allowed statuses for an unknown, empty or repeated `status` (and the orders list for an unreadable or repeated `dateFrom`/`dateTo`; a date-only `dateTo` now covers its whole UTC day), where they answered 200. Pending reviews in `GET /api/admin/reviews` carry `productName` and `productSlug`.
`GET /api/products/search` answers 400 for a missing, blank or repeated `q`, so `client.products.search('')` now rejects with `validation.failed`: a store's own search box should skip an empty input.
