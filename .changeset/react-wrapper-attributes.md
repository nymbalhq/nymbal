---
'@nymbalhq/react': patch
---

A wrapped element no longer renders its default state first: it has its attributes (`qty`, `client`, `cart`) when it connects, even when the element was already defined.
