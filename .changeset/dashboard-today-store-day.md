---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
---

The dashboard's today figures follow `store.timezone` and count every paid order of the day, with refunds on the day they were made. Breaking: `GET /api/admin/dashboard` replaces `today.orderCount`, `today.revenueMinor` and `today.itemsShipped` with `paidOrders`, `units` and `money` (one row per currency, `netCapturedMinor`).
