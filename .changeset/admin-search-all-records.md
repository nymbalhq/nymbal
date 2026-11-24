---
'@nymbalhq/platform': patch
---

Admin search now finds any order and any customer, not only recent orders and the customers who placed them, and an order whose number is the term comes first; on SQLite the admin orders list's `q` and `customer` filters now fold case in any script, not ASCII alone.
