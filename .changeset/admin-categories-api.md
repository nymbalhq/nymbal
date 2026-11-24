---
'@nymbalhq/platform': minor
---

Admin routes under `/api/admin/categories` list, create, change, reorder and delete categories; a parent must exist and cannot be the category or one of its descendants, and a delete moves its products out and its children up to its parent.
