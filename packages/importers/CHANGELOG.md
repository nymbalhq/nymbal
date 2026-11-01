# @nymbalhq/importers

## 0.3.4

### Patch Changes

- Updated dependencies [6c85536]
- Updated dependencies [f05e635]
- Updated dependencies [d2513b9]
- Updated dependencies [0b51500]
- Updated dependencies [bb453b8]
- Updated dependencies [5db4e1b]
- Updated dependencies [39c852e]
- Updated dependencies [eed87ad]
- Updated dependencies [59e1639]
- Updated dependencies [965b85a]
- Updated dependencies [ca1a5f6]
- Updated dependencies [95dad2e]
- Updated dependencies [733d4b1]
- Updated dependencies [c778b26]
- Updated dependencies [0b51500]
- Updated dependencies [86724f2]
- Updated dependencies [a67f867]
- Updated dependencies [ab6c631]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
  - @nymbalhq/platform@1.5.0
  - @nymbalhq/config@1.5.0
  - @nymbalhq/types@1.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [d724fd2]
- Updated dependencies [63ede12]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [d546cd3]
- Updated dependencies [d546cd3]
- Updated dependencies [dbf1425]
- Updated dependencies [ea1926d]
- Updated dependencies [c8588b2]
  - @nymbalhq/platform@1.4.0
  - @nymbalhq/types@1.4.0
  - @nymbalhq/config@1.4.0

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
