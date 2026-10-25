---
'@nymbalhq/platform': patch
---

`GET /api/orders` and `GET /api/orders/:orderNumber` no longer return an order's internal fields: `metadata` is `{}`, `notes` is `''`, `paymentIntentId` is `null` and history entries carry no `actor`. The admin order routes still return them.
