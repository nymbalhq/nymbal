---
'nymbal': patch
'@nymbalhq/importers': patch
---

`nymbal import` names each product image it could not bring over, with why (an HTTP status, a timeout, an unsupported type or a refused address), under "Media" in the migration report, and still imports the product with its other images. The report groups errors and review items by phase with counts, and the summary says "AI enrichment: off" when no AI provider is set.
