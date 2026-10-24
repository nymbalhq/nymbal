# @nymbalhq/contract-tests

## 1.2.0

- First release: the suites every adapter passes (`run<Kind>Contract`, `contractSuites`), for certifying your own with
  `nymbal test:contracts --package`.
- The document store suite checks `replaceCollection`, so a third-party store must implement it.
