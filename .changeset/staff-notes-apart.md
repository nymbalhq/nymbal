---
'@nymbalhq/platform': minor
'@nymbalhq/admin': patch
---

Staff and system notes on an order are stored apart from the shopper's checkout note (new column `orders.staff_notes`; run migrations), so a checkout note is always shown word for word as the customer's. An order noted before this release shows its old note list as the shopper's note.
