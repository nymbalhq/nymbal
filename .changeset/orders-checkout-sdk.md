---
'@nymbalhq/sdk': minor
---

The checkout begin is never sent again without the shopper's token after a failed refresh (`RequestOptions.keepIdentity`), and the checkout store keeps the API's `errorCode` beside `error`.
