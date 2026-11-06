---
'nymbal': minor
'@nymbalhq/importers': minor
---

`nymbal import --since last` (or `--since <date>`) brings over what changed in WooCommerce since your last import: new products, customers, orders and reviews are created, and imported products take their new names, copy, images and prices (stock is left alone). An imported order that changed is counted, not rewritten; the report gains a "Changes since" section.
`@nymbalhq/importers` exports `resolveSince` and `ImportSinceError`.
