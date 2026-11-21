---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/payments-stripe': minor
---

Breaking for a third-party payments adapter: `PaymentsAdapter` gains a required `listRefunds(paymentId)` (oldest first), and `refund` must record its `idempotencyKey` where the list returns it.
A refund made in the provider's dashboard now appears on the order, and a refund left pending by a lost answer settles from the provider's list within minutes. Stripe endpoints also subscribe to `charge.refunded`.
