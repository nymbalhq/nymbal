---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/contract-tests': minor
'nymbal': patch
'@nymbalhq/admin': patch
---

Discount codes: a `promotions` commerce slot with a native engine, `POST /api/cart/codes` and admin routes under `/api/admin/promotions`.
Cart, order and charge now come from one totals function; `POST /api/checkout` accepts `expectedTotalMinor` and refuses any other total.
