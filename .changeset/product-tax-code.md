---
'@nymbalhq/platform': minor
'@nymbalhq/admin': minor
---

Products take a `taxCode` on create and update (null clears it), and checkout taxes their lines at that code's rate; Duplicate copies it. The admin's product form gains a Tax code field.
