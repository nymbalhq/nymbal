# @nymbalhq/importers

## 0.3.2

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/platform@1.3.0
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 0.3.1

- Versioned with the other packages; no changes of its own.

## 0.3.0

- Product images go to the store's media storage. **Breaking:** `WooCommerceImporterDeps` takes a required `media` (pass
  `app.platform.media`), and a failed image put is reported in `errors`.

## 0.2.1

- Skips AI enrichment when the store has no AI provider.

## 0.2.0

- First release under `@nymbalhq`.
- Paid WooCommerce orders import as captured.
- A fresh import state no longer shares ids, maps and errors with earlier imports in the same process.
