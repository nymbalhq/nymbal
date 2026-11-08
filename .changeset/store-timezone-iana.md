---
'@nymbalhq/config': patch
---

Breaking: a `store.timezone` that is not an IANA time zone (such as `London` or `GMT+1`) is now refused at startup; use a zone such as `Europe/London`.
