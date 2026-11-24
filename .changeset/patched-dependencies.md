---
'create-nymbal-app': patch
'@nymbalhq/admin': patch
---

New Astro stores start on `astro` 7.4.7 and `@astrojs/node` 11.1.12 or later, which fix a file read through the `/_image` endpoint and an XSS through dynamic tag names.
The admin bundles `react-router-dom` 6.30.6, which fixes two open-redirect advisories.
