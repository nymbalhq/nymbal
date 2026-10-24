---
'@nymbalhq/platform': minor
'@nymbalhq/http': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/media-s3': minor
'nymbal': minor
---

The event log is something an operator can read: one id follows an operation through every event it causes, the CLI
reads the log, and old events can be archived before they are deleted.

- **One correlation id per operation.** Every event an HTTP request publishes carries the request's correlation id,
  and every response carries it as `x-correlation-id`, Fastify's own 404 and 400 included. An inbound
  `x-correlation-id` is used only when it matches `^[A-Za-z0-9._:-]{1,128}$` (`isValidCorrelationId`); any other
  value is replaced by the request's own id. A checkout keeps its id across the payment webhook, on its failure paths
  too. Each sweeper run and each `nymbal import` run gets one id of its own, such as `sweep:cart-abandonment:<uuid>` or
  `import:woocommerce:<uuid>`. Services take no new arguments: `runWithCorrelation(id, fn)` and
  `currentCorrelationId()` carry the scope.
- **A queryable column.** Migration `0008` adds `events.correlation_id`, indexed with `seq`, and backfills it from each
  stored envelope. Run `nymbal migrate`. The event log repository adds `queryByCorrelation`, `listAfter`, `maxSeq`,
  `listDeliveredBefore` and `deleteSeqs`, and its rows carry `createdAt`.
- **`nymbal events`.** `nymbal events query --correlation <id>` prints one operation's events in `seq` order, and
  `nymbal events tail` follows the log live. Both take `--type 'order.*'` and `--json`, and both open the store
  read-only. Payloads are printed only with `--payload`.
- **Retention and archive.** `events.retentionDays` (default 30) sets how long delivered events stay. With
  `events.archive: { adapter: 's3', bucket, … }`, each batch of expired events is first written as one gzip NDJSON
  object, and deleted only once the write succeeds. The archive bucket must be private: config refuses the media
  bucket. `@nymbalhq/media-s3` adds `createS3ObjectWriter` for private objects.
