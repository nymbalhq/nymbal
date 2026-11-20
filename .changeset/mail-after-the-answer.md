---
'@nymbalhq/platform': minor
'@nymbalhq/types': patch
'nymbal': patch
---

Breaking: a command now answers once its events reach the `derived` subscriptions (projections, search, report rollups); mail, webhooks and a store's own subscriptions run after the answer, so a slow mail provider no longer slows requests or shows which addresses have accounts. A derived handler runs at the commit and again on delivery, so it must be idempotent; call `relay.drain()` to wait for every subscription.
