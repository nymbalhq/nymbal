---
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'@nymbalhq/http': minor
'@nymbalhq/platform': minor
'@nymbalhq/security-cloudflare': minor
'nymbal': minor
---

Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
