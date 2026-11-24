---
'@nymbalhq/platform': minor
'@nymbalhq/admin': patch
---

Breaking: `POST /api/admin/products/:id/duplicate` now takes the first free suffix (`-copy`, `-copy-2`, …) on the slug and SKUs, so a product can be duplicated again, and the copy starts with no stock. The admin's products row menu is always shown and reports each Duplicate and Archive; the sidebar's Orders badge shows the pending count.
