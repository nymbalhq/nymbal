---
'@nymbalhq/types': patch
'@nymbalhq/web-components': patch
'@nymbalhq/react': patch
---

Storefront client bundles are about 30 bytes smaller (the document-order collator is made on first use), and the
web components and React wrappers build to the same bytes every time.
