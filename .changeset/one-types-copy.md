---
'@nymbalhq/platform': patch
---

A store whose adapter loads its own copy of `@nymbalhq/types` now fails to start, naming both copies, instead of
mishandling that adapter's errors.
