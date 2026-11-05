---
'@nymbalhq/shipping-aftership': minor
'@nymbalhq/shipping-easypost': minor
'@nymbalhq/contract-tests': minor
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
---

Shipping adapters declare `rates`, `labels` and `tracking` and have only those methods (`rate`, `createLabel` and the new `startTracking` are optional; `track()` and `ShippingTracking` are removed; rate and label params and results are reshaped; native declares none), `GET /api/capabilities` reports `shipping`, and `runShippingContract` checks the words against the methods.
A shipped order's tracking number is registered with a provider that declares `tracking`: `@nymbalhq/shipping-easypost` with an `apiKey` (which also rates and buys labels), or the new `@nymbalhq/shipping-aftership`.
`store.shipFrom` sets the address the store ships from.
