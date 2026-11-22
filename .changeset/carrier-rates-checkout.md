---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'@nymbalhq/contract-tests': minor
'nymbal': minor
---

`commerce.shipping.pricing: 'carrier'` (default `'table'`) charges what the shipping adapter rates (EasyPost with an `apiKey`): it needs `defaultWeightGrams`, `store.shipFrom`, no table rows and an adapter that declares `rates`; the cart is one parcel of variant weights (set by the WooCommerce importer or the API until the admin has a weight field), and a carrier that is down or slower than 5 s answers 503 `checkout.shipping_unavailable`.
`POST /api/checkout/quote` has a built-in limit of 30 a minute per cart, counted as `/api/checkout`'s; raise it the same way for load tests. The shipping contract asks for a carrier and a service name that stay the same between calls.
Breaking: `CheckoutError` gains `shipping_unavailable` (an exhaustive switch over its codes stops compiling), an order's `metadata.shipping.provider` is any provider name rather than only `native`, and the ACP surface's deps take `shippingPricing`.
