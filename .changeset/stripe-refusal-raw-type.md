---
'@nymbalhq/payments-stripe': patch
---

A refund Stripe refuses is recognised by the API's error type rather than the SDK's error class name; a refused API key leaves the refund pending.
