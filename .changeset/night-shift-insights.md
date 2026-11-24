---
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

A nightly job writes insights about stock running out, searches that found nothing, falling orders or checkout success, rising refunds and the store's own failures, configured under `nightShift: { enabled, at }` (on, from 03:00 store time, by default). Each is published as the new event `insight.created.v1`.
