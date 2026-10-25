---
'@nymbalhq/platform': patch
---

The refresh cookie's Max-Age follows `security.auth.refreshTtl`, so it no longer outlives the token it carries.
