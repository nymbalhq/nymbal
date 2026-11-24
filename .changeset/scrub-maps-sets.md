---
'@nymbalhq/platform': patch
---

Settings secrets inside a `Map` or `Set` are now scrubbed from logs and error responses, as they already were inside plain objects, arrays and errors.
