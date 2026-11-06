---
'@nymbalhq/web-components': minor
---

`<nymbal-checkout>` refuses an order that needs payment when the page has no payment element, and asks a shopper whose session ended to sign in again (`sign-in-href`, default `/account/login?redirect=%2Fcheckout`).
