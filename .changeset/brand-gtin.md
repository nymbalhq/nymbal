---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/sdk': minor
'@nymbalhq/admin': minor
'create-nymbal-app': patch
---

A product has a brand and each variant a GTIN, set in the admin and served in the product page's JSON-LD and the agent feeds; a number that is not a GTIN is refused.
Breaking: the product document gains a required `brand` and a `gtin` on each variant; run `nymbal replay --to catalogue` on an existing store so its documents carry them.
