---
'nymbal': minor
'@nymbalhq/importers': minor
---

`nymbal import --dry-run` reads the WooCommerce store and writes `nymbal-import-plan.json` and `.md`: what the import would create, refuse and skip, slug, SKU and order-number clashes with the source or your store, the fields it never reads, a time estimate and what does not migrate. It imports nothing and opens your store read-only.
