---
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/sdk': minor
'@nymbalhq/admin': minor
'nymbal': minor
'create-nymbal-app': patch
---

`agents.roles.content`: a weekly night-shift review that proposes product SEO titles and descriptions for the Inbox, checked against copy rules and the product's own facts; `nymbal eval content` scores it.
Product pages use a product's `seoTitle` and `seoDescription` for the `<title>` and meta description when set. Breaking: the product document and the SDK's `DenormalisedProduct` gain required `seoTitle` and `seoDescription` (run `nymbal replay`), and the demo seed leaves both blank.
