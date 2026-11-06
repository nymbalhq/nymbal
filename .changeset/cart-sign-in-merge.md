---
'@nymbalhq/platform': minor
---

A guest's cart joins the customer's at sign-in (quantities summed, at most 99 a line), logout ends the cart cookie, and the cart refuses a line above 99, an unknown body key and a variant not for sale. `createCartService` now takes `catalogue: createCartCatalogue(repos)`.
