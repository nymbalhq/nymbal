---
'@nymbalhq/contract-tests': minor
---

`runPaymentsContract` now checks `listRefunds`: an adapter that loses a refund's key, lists another payment's refund or moves money while listing fails the suite.
