# @nymbalhq/doc-store-postgres-jsonb

## 1.2.0

- Implements `replaceCollection` in one transaction, for `nymbal replay`.

## 1.1.0

- First release: the `postgres-jsonb` document store. It needs `commandStore: 'postgres'`, uses `DATABASE_URL`, and owns
  one table, `nymbal_documents`.
- `healthCheck()` reads the table (`degraded` until it exists).
