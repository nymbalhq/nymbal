---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/sdk': minor
'@nymbalhq/react': minor
'create-nymbal-app': minor
---

A checkout that completes. `POST /api/checkout` now answers the payment outcome (`payment: { status: 'succeeded' |
'requires_action' | 'failed', reason? }` and `orderStatus`). When the payments adapter captures at once, as the
`native-stub` adapter now does, the order is confirmed, its stock committed and its cart emptied in the same request;
Stripe orders are still confirmed by the webhook. The stub takes test triggers from the receipt email: a local part
ending `+stub-pending` stays pending, `+stub-decline` fails. One cart has at most one pending order (migration `0005`,
`orders.cart_token` with a partial unique index): a resubmit answers the same order, a changed cart cancels the old
intent and supersedes its order (409 `checkout.payment_in_progress` when the provider refuses), an emptied cart
answers 409 `checkout.cart_empty` naming the order it became, and a pending order left without an intent is
abandoned after 120 s. A capture for a cancelled order, or one that cannot confirm its order, is refunded. The
`order-placed` email is sent once per order on `order.paid`, not on `order.placed`, so an unpaid or imported order
sends none.

`PaymentsAdapter` gains `cancelPaymentIntent(intentId)` and `getPaymentIntent(intentId)`, and
`PaymentIntentParams.receiptEmail`; a third-party adapter must implement both methods. In the SDK,
`checkout.submitPayment()` resolves to the server's result (or `null`), `paymentStatus` is `succeeded` only when the
server says so and `requires_action` while Stripe must confirm, `checkout.markConfirmed()` is new, and the cart store
reloads after a submit. Both templates follow `payment.status`, and their order pages show the order's real state
("Awaiting payment" for a pending order).
