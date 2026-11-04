---
'nymbal': minor
'@nymbalhq/importers': minor
'create-nymbal-app': patch
---

`nymbal preview --source woocommerce --url … --key … --secret …` imports your WooCommerce store into a throwaway store and serves it on your storefront, and writes `nymbal-preview-report.{json,md}` (counts, differences, drafts) and `nymbal-redirects.csv`; your own store is not touched. A store already scaffolded copies `src/lib/page-policy.ts` (Astro) or `lib/page-policy.mjs` (Next.js) so images load from the API's origin.

`nymbal import`: of two products whose slugs clash, the first in WooCommerce keeps the slug.
