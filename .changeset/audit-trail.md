---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/http': minor
'@nymbalhq/admin': minor
'nymbal': minor
---

Every change an admin, a shopper or the system makes to the store's records leaves an audit entry, and an admin write
sent with an `Idempotency-Key` applies once, however often it is retried.

- **Audit entries.** Migration `0010_audit_entries` adds an append-only `audit_entries` table (both dialects; its
  triggers refuse updates and deletes, and the event-retention sweep never touches it). One entry per outermost
  command, written in the command's transaction, so a rolled-back write leaves none. It names the actor (`admin:<id>`,
  `customer:<id>`, `guest:anonymous`, `system:<sweeper>`, `system:stripe-webhook`, `import:woocommerce`), the command
  (`inventory.adjust`, `order.cancel`, `checkout.place`, `product.create`, …), the records it touched by id, the
  request's correlation id and the outcome: `applied`, `refused` (its service refused it) or `replayed`. Cart commands
  and reads are not audited; a request its schema refuses leaves no entry.
- **Idempotency.** Admin writes (`POST`, `PATCH`, `PUT`, `DELETE` under `/api/admin`) accept `Idempotency-Key`, 1-128
  characters of `[A-Za-z0-9._:-]`; any other value answers 400 naming the header. A retry with the same key and the
  same request answers the first response exactly, with `Idempotent-Replayed: true`, and runs nothing; the same key
  with a different body or path answers 409 `idempotency.key_reused`. Concurrent first attempts apply once. A refused
  command is not stored for replay: its retry runs again. Without a key, a write behaves as before.
- **Activity.** `GET /api/admin/activity?actor&command&subject&correlation&outcome&since&until&cursor&limit` lists
  entries newest first, a page at a time (`meta.nextCursor`), with each response's status but never its body.
  `GET /api/admin/activity/export?since&until&correlation` streams them oldest first as NDJSON, ids only.
- **Admin.** A new Activity page (`/admin/activity`) filters the trail and downloads the export. Every admin write
  sends a key per user intent: a double click within one action sends one key, and the client's own re-sends (after a
  CSRF refusal or a 401 refresh) reuse it. The stock-history drawer now shows a variant's adjustments; it was always
  empty.
- **CLI.** `nymbal audit export [--since <t>] [--until <t>] [--correlation <id>] [--out <file>]` prints the same NDJSON,
  opening the store read-only; a bad time exits 2. `nymbal import` attributes its writes to `import:woocommerce`.
- **CORS.** `x-correlation-id` and `Idempotent-Replayed` are in `Access-Control-Expose-Headers`.
- **API.** `@nymbalhq/platform` exports `runAsActor`, `currentActor`, `actorOf`, `audit.note`, `auditedCommand` and
  the `audit_entries` repository; `@nymbalhq/types` adds `AuditEntry`, `AuditActor`, `AuditOutcome`, `AuditSubject`,
  `IDEMPOTENCY_KEY_HEADER`, `IDEMPOTENT_REPLAYED_HEADER` and `isValidIdempotencyKey`. Every non-GET entry in
  `routeSchemas` declares its audit `command` (or `null`); a route without one stops startup.
