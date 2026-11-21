---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/admin': minor
'@nymbalhq/contract-tests': minor
'nymbal': minor
---

Checkout charges tax from `commerce.tax.rates` (a row per country or US state, optional per-code rates; `onUnavailable: 'refuse' | 'native'`), and `store.pricesIncludeTax: true` extracts it from prices, shown as "Tax (included)"; a store with no rates is unchanged.
Tax added on top of prices is charged only when `POST /api/checkout` sends the taxed total as `expectedTotalMinor`; the checkout element and agent checkouts do not send it yet, so they are refused on such a store.
Breaking for a `custom` tax adapter: `calculate` is replaced by `capabilities()` and `quote()` (optional `commit` and `refund`); run `runTaxContract` from `@nymbalhq/contract-tests` against it.
