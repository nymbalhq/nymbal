---
'nymbal': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/payments-stripe': minor
---

`nymbal heartbeat` checks once, for cron, that the store takes an order and that a saved card can be charged and refunded; turn on `features.heartbeat` and set the `heartbeat` block. A checkout with the heartbeat address is placed and cancelled without payment (`checkout.synthetic`) and kept out of the admin's lists (`?source=synthetic` lists them).
Payments adapters gain `chargeSavedCard` behind a `saved-card` capability (native stub and Stripe); Stripe ignores the heartbeat charge's webhooks.
