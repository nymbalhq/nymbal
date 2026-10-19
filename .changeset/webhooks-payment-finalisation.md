---
'@nymbalhq/platform': minor
'@nymbalhq/http': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
---

Verified Stripe webhooks and recorded payment outcomes.

**Signatures.** The Fastify adapter keeps the exact request bytes for routes registered with `rawBody: true`. It still
parses JSON with Fastify's own parser, so a malformed, empty or prototype-poisoned body still gets 400. The Stripe
webhook verifies those exact bytes, and a bad signature answers 400 `webhook.invalid` instead of 500.

**Captured payments.** `checkout.finalize(intent, { amountMinor, currency })` confirms an order only when the captured
amount and currency equal its total. Every other capture is recorded with a reason, answered 200 so Stripe stops
retrying, and published as `payment.failed` with an order-history note. The reasons are:

- `amount_mismatch`, `order_not_pending`, `no_order` and `malformed_capture`;
- `stock_unavailable`, for a payment that arrived after its reservation expired and whose stock is gone.

A late payment re-takes its stock when it can. The `pending → confirmed` write is conditional and a failed re-take
re-reads the order, so concurrent deliveries confirm an order once. Webhook dedupe moved to the command store and is
recorded only when its work commits, so a failed delivery is retried and a restart forgets nothing.

**Production refusals.** `createApp` refuses to start with the stub payments adapter or the default JWT secret.
`ConfigError` takes an optional `code`. `DEFAULT_JWT_SECRET` is exported from `@nymbalhq/config`.

**Kernel.** `CommandStore.savepoint(fn)` rolls back only `fn`'s writes inside an open transaction.
`inventory.tryReserveStock` returns null on short stock instead of throwing.
