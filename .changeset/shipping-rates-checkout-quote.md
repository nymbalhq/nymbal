---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/admin': minor
'@nymbalhq/contract-tests': minor
'nymbal': minor
---

`commerce.shipping.rates` sets flat delivery options per country (optional `freeOverMinor`); `POST /api/checkout/quote` (MCP `checkout_quote`) prices the cart with shipping and tax, the checkout element and ACP show it and send `shippingOptionId` and `expectedTotalMinor`, and a checkout charging shipping or tax on top with no `expectedTotalMinor` is refused.
Tax rows gain `taxShipping` (default `true`): a store that zero-rates goods through `codes` still taxes delivery at the row's percent unless the row sets `taxShipping: false`.
Breaking: the SDK drops `setShippingMethod` and `ShippingMethod`; use `quote()` and `selectShippingOption(id)` (`useCheckout()`: `requestQuote` and `selectShippingOption`), and the state's `quote` and `quoting`.
