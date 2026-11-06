---
'@nymbalhq/http': patch
---

Only `GET /api/csrf` sets the `nymbal.csrf` cookie, so a guest's first parallel requests no longer leave it different from the token; a client of your own fetches `GET /api/csrf` before its first write. API answers that set no caching of their own now say `Cache-Control: no-store`.
