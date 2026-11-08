---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/importers': minor
'@nymbalhq/admin': minor
'create-nymbal-app': minor
---

Breaking: a refund no longer changes an order's `status`, which now only says where the goods are. `OrderStatus` loses `refunded` and `partially_refunded` on every read, `statusBeforePartialRefund` and `orderMovesFrom` are gone, `?status=refunded` and `?status=partially_refunded` answer 400, and stored orders migrate on boot; event types and payloads are unchanged.
Read a refund from `payment.state`, now on shopper order answers, and filter with `?payment=unpaid|paid|partially_refunded|refunded`. A fully refunded unshipped order stays in `?status=confirmed`, and `?payment=` separates it; fulfilling it answers 409 `order.refunded`, while a shipped one may still be delivered. `@nymbalhq/types` adds `fulfilmentMoves` and `canRefund`.
WooCommerce `refunded` orders import as `confirmed`.
