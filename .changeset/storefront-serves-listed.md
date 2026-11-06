---
'@nymbalhq/platform': patch
---

The storefront serves only active products and their active variants, two admin price edits of one variant at once log a true price history, and `GET /api/categories` returns every category. A store on a package search adapter (Algolia) runs `nymbal replay --to search` after upgrading to drop drafts from its index.
