# @nymbalhq/document-store-postgres-jsonb

## 1.4.0

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- Implements `replaceCollection` in one transaction, for `nymbal replay`.

## 1.1.0

- First release: the `postgres-jsonb` document store. It needs `commandStore: 'postgres'`, uses `DATABASE_URL`, and owns
  one table, `nymbal_documents`.
- `healthCheck()` reads the table (`degraded` until it exists).
