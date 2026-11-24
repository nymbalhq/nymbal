---
'@nymbalhq/platform': minor
'@nymbalhq/admin': minor
'@nymbalhq/importers': patch
---

A product update sets each variant's `weightGrams` (null clears it), and the admin's variant table gains a Weight (g) field. `weightGrams` is now whole grams from 0 to 1,000,000 on create and update; a fraction or negative is refused with 400.
The WooCommerce importer imports a weight over 1,000,000 g as none and lists it in the import report's warnings.
