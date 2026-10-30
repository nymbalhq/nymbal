---
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': patch
'create-nymbal-app': patch
---

The storefront client can be built from `@nymbalhq/sdk/core` plus the `@nymbalhq/sdk/ns/*` namespaces a page uses; the
Astro template does so. A store's own element that reads `client.cart`, `client.checkout` or another store namespace
imports its `@nymbalhq/sdk/ns/<name>` module.
