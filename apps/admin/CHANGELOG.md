# @nymbalhq/admin

## 0.2.0

### Minor Changes

- 4e7e079: The admin tells the truth about money. Orders store what was captured and refunded (migration `0006`:
  `orders.captured_minor`, `captured_at`, `refunded_minor`, `capture_method`, and an `order_refunds` table; existing
  orders are backfilled from their status). `Order` gains `capturedMinor`, `capturedAt`, `refundedMinor` and
  `captureMethod`, and `@nymbalhq/types` exports `paymentState(order)`, `refundableMinor(order, refunds)`, `OrderRefund`
  and `OrderPayment`. Admin order reads carry `payment: { state, capturedMinor, refundedMinor, refundableMinor,
currency, refunds }`.

  `POST /api/admin/orders/:id/refund { amountMinor, reason? }` now moves money through the payments adapter (once per
  refund, keyed by the refund's id) and answers `{ order, payment, refund }`; it refuses 409 `refund.not_captured` and
  `refund.exceeds_captured`. `partial-refund` is gone: every refund is by amount. `mark-paid` takes `{ note? }` and
  records a manual capture of the order's total, confirming it like a payment (409 `order.stock_unavailable` when its
  released stock is gone). `confirm` refuses an unpaid order (409 `order.unpaid`), `cancel` a paid one (409
  `order.paid`), and a transition the status table forbids answers 409 `status.invalid_transition`. A capture refunded
  because its order was cancelled is recorded, so the order nets to zero. Dashboard revenue and customer spend count
  captured less refunded.

  `PaymentsAdapter.refund` gains `opts: { idempotencyKey?, currency? }` and throws `PaymentError('refund_rejected')` when
  no money moved or `PaymentError('refund_unknown')` when it may have (`refund_failed` is gone). The `native-stub` adapter
  refunds like a provider: it refuses an id it did not mint, an uncaptured intent and an over-refund. Order refund
  events carry `refundId` and `currency`, and `order.partially_refunded` drops `lineItems`. The WooCommerce importer
  records paid orders as captured. The admin shows a Payment panel and column, refunds by amount, and records a payment
  instead of confirming an unpaid order.

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
