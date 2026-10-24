---
'@nymbalhq/web-components': patch
---

`nymbal-mini-cart` renders no text node for an empty badge. Before, a hydrated mini-cart whose server HTML had an
empty badge kept it empty after a soft navigation, though the cart had items.
