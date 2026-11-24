---
'@nymbalhq/platform': minor
'nymbal': patch
---

A tax provider that declares `commit` and `refund` now has paid orders and their refunds filed with it in the background, retried every 5 minutes, and `nymbal doctor` shows a `tax documents` line.
