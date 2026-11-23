---
'@nymbalhq/web-components': patch
'create-nymbal-app': patch
---

`nymbal-add-to-cart` shows why an add was refused in a new `error` part and no longer fires `nymbal:cart:item-added` for it, so the cart drawer stays closed.
Templates: the Next.js footer's About column is text instead of links to pages the template lacks, the Astro account navigation wraps at phone width, and the guest order page leaves out an empty timeline.
