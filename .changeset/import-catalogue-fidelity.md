---
'nymbal': minor
'@nymbalhq/importers': minor
---

`nymbal import` charges WooCommerce's sale prices with the regular price as compare-at, keeps counted stock (untracked items at `--untracked-stock`, default 1000), reads weights, sizes and prices in the store's own units and currency, and refuses a store in another currency. Grouped, external and price-less products arrive as drafts; tags, attributes, tax and shipping classes and public custom fields stay in `metadata.woocommerce`, also after AI enrichment.
What could not be carried over exactly is listed under "Review before launch" in the migration report.
