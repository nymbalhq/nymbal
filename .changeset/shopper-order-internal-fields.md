---
'@nymbalhq/platform': patch
---

`GET /api/orders` and `GET /api/orders/:orderNumber` no longer return an order's internal fields: `metadata` is `{}`, `notes` is `''` and `paymentIntentId` is `null`. The admin order routes still return them.
