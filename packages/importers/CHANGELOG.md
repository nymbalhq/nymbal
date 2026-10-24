# @nymbalhq/importers

## 0.3.0

### Minor Changes

- 1b6da9e: A store can keep its media in an S3-compatible bucket: `infrastructure.media: 's3'`. Each stored object is
  `<prefix>/<key>` in the bucket, and its URL is the bucket's public URL. The storage is the new `@nymbalhq/media-s3`
  package, which the kernel imports only when the config names it: `npm install @nymbalhq/media-s3 @aws-sdk/client-s3`.
  A missing package fails `createApp` with `adapter.package_missing` and that install line.
  - An optional `infrastructure.s3` block takes `bucket`, `region`, `endpoint`, `prefix`, `publicUrl` and
    `forcePathStyle`. Each falls back to the environment: `S3_BUCKET`, `AWS_REGION`, `S3_ENDPOINT`, `NYMBAL_S3_PREFIX`
    and `S3_PUBLIC_URL`. The region defaults to `us-east-1`, there is no prefix by default, and requests are path-style
    when an endpoint is set.
  - With no bucket in the block or `S3_BUCKET`, `createApp` fails `config.s3_bucket_missing` before anything is loaded.
  - Credentials are never config keys: the AWS SDK's default chain provides them (`AWS_ACCESS_KEY_ID` /
    `AWS_SECRET_ACCESS_KEY`, a profile or a role). Any other key inside the block, and an `s3` block while `media` is
    not `'s3'`, fail `loadConfig` naming the key.
  - A URL is `publicUrl` when it is set, else `endpoint/bucket`, else `https://<bucket>.s3.<region>.amazonaws.com`.
    The object key follows it, with each path segment percent-encoded. The storage never creates buckets or sets
    policies: the bucket must already serve its objects publicly.

  `nymbal import` now writes product images to the store's media storage. With `local-fs` (the default) that is the
  same files under `public/imported-media` with the same `/imported-media/...` URLs as before. The import no longer
  crashes at start on `p.bold is not a function`.

  **Breaking for code that calls the importer (`@nymbalhq/importers`).** `WooCommerceImporterDeps` takes a required
  `media: MediaStorage`, and `runWooCommerceImport` builds no storage of its own: pass `app.platform.media`.
  `WooCommerceImportOptions.projectRoot` stays, but media no longer uses it. A `put` that rejects is now reported, not
  dropped: the product is created with the images that did store, the report's `errors` gets
  `{ phase: 'media', id: <WooCommerce product id>, error }`, and an `error` progress event matches it.

### Patch Changes

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [1b6da9e]
- Updated dependencies [ea74a39]
  - @nymbalhq/platform@1.1.0
  - @nymbalhq/types@1.1.0
  - @nymbalhq/config@1.1.0

## 0.2.1

### Patch Changes

- 6571ce9: Provider SDKs leave the kernel. `@nymbalhq/platform` no longer depends on `stripe`, `@anthropic-ai/sdk` or
  `nodemailer`: each lives in its own package, `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and
  `@nymbalhq/adapter-smtp`, which the kernel imports only when `nymbal.config.ts` names its provider. A store that uses
  one installs it and its SDK (`npm install @nymbalhq/adapter-stripe stripe`); if it is missing, `createApp` fails with
  `adapter.package_missing` and prints that line for the package manager in use.

  **Breaking: the config only accepts providers it knows.** Each commerce slot's `provider` is now one of
  `KNOWN_PROVIDERS` (exported by `@nymbalhq/config`): payments `native` or `stripe`; email `native` (console) or `smtp`;
  ai `none` or `anthropic`; reviews, search, analytics, shipping and tax `native`; and `custom` for every slot. Any other
  string, which used to load and silently run the native stub, now fails `loadConfig` naming the slot and the providers
  it accepts. In particular:
  - `ai: { provider: 'native' }` is no longer accepted: use `ai: { provider: 'none' }`, which builds no AI adapter
    (`app.adapters.ai` is `null`, and the admin's AI route answers 503).
  - SMTP mail moves from `email: { provider: 'native', config: { transport: 'smtp', smtp } }` to
    `email: { provider: 'smtp', config: { smtp } }` plus `@nymbalhq/adapter-smtp` and `nodemailer`. The old form fails
    `loadConfig` instead of printing mail to the console.
  - The Anthropic key is read from `ai.config.apiKey`, falling back to `ANTHROPIC_API_KEY`.

  **`createApp(config, { adapters })`** takes a project's own adapter for any slot whose provider is `custom`. A `custom`
  slot with nothing injected, or an adapter injected for a slot that is not `custom`, fails with
  `adapter.custom_mismatch`. `nymbal dev` and `nymbal start` cannot inject adapters yet. In production the stub-payments
  refusal reads the resolved adapter, so an injected stub is refused and an injected real adapter starts.

  **Capabilities.** `capabilities` is now a method, `capabilities(): readonly string[]`, on every adapter, the document
  store, the event bus and `MediaStorage`; adapters written against the old `capabilities` array must become a function.
  `app.capabilities()` reports each slot's provider and its adapter's answer. The native payments stub no longer lists
  `webhook`, since it verifies no signature.

  The kernel no longer exports `createStripePaymentsAdapter` or `createAnthropicAiAdapter` (import them from the adapter
  packages), and `createNativeEmailAdapter` keeps only the console transport. A new project's config defaults ai to
  `none`, so a fresh store installs no provider SDK. The WooCommerce importer skips AI enrichment when the store has no
  AI provider.

- Updated dependencies [6571ce9]
  - @nymbalhq/platform@1.0.0
  - @nymbalhq/config@1.0.0
  - @nymbalhq/types@1.0.0

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

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.

### Patch Changes

- 1743000: A fresh import state no longer shares imported ids, maps and errors with earlier imports in the same process.
- Updated dependencies [d12c7ec]
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [ccd3d36]
- Updated dependencies [ac2b2bb]
- Updated dependencies [edababa]
- Updated dependencies [22b4523]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e90bf2d]
  - @nymbalhq/platform@0.2.0
  - @nymbalhq/types@0.2.0
  - @nymbalhq/config@0.2.0
