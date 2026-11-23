---
'@nymbalhq/importers': patch
---

`planWooCommerceImport` refuses a WooCommerce store in another currency, as the import does, before it reads a record.
A delta import (`--since`) now reports a re-listed product's own warnings (unsellable, a sale, no price); lines about stock, which a delta leaves as imported, stay out. A variation whose WooCommerce price was cleared keeps its stored price in a delta, and the report says so.
