---
'@nymbalhq/platform': patch
---

Expired and used refresh tokens are now deleted on a schedule, so the table holds about one row per signed-in session.
A signed refresh token whose row is gone (for example after restoring an older database backup) now ends that customer's sessions instead of only being refused.
