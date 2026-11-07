---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/admin': minor
---

An order refunded in part can still be processed, shipped and marked delivered (in the admin, the API or by a carrier's delivered update), moving on only from the status it was refunded at; its payment keeps reading partially refunded.
A further partial refund no longer moves the order's status, and still shows on the order's timeline. New in `@nymbalhq/types`: `orderMovesFrom` and `statusBeforePartialRefund`.
