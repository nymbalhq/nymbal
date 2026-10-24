# @nymbalhq/admin

## 1.2.0

- Activity page (`/admin/activity`): the audit trail of every write, filtered by actor, command, record or correlation
  id, with an NDJSON export. Every write sends an `Idempotency-Key`, so a double click applies once.
- Settings page: enter the provider keys the config leaves unset. Each is saved encrypted, never shown again, and
  applied when the store restarts.
- The stock-history drawer shows a variant's adjustments.

## 1.1.0

- Versioned with the other packages; no changes of its own.

## 1.0.0

- Fits a phone: below 768 px the sidebar folds behind a menu button and the pages stack.

## 0.2.0

- First release under `@nymbalhq`.
- Served by `nymbal dev` at `/admin/`; a reload keeps the merchant signed in, and orders arrive live.
- A Payment panel shows what was captured and refunded. Refunds are by amount, and an unpaid order is marked paid rather
  than confirmed.
