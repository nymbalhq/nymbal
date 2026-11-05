---
'nymbal': minor
'@nymbalhq/importers': minor
---

`nymbal preview --lighthouse` builds your storefront for production and compares Lighthouse scores (median of `--lighthouse-runs`, default 3) of your WooCommerce home, a product and a category with the same pages in the preview, in a `## Lighthouse` section of the report. Install `lighthouse@^12` in the project, or point `NYMBAL_LIGHTHOUSE_CLI` at one; Chrome is needed.
