---
'@nymbalhq/admin': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
---

The admin has a Reviews page: approve or reject submitted reviews, and change a decision from the Approved or Rejected tab.
`GET /api/admin/reviews` takes `status` (pending by default), and moderating a review that does not exist answers 404.
