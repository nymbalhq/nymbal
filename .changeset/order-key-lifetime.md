---
'@nymbalhq/platform': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'create-nymbal-app': minor
---

Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
or asks for a new link. Signed-in shoppers go to their account's order page.

Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
makes every field the confirmation page does not show optional.
