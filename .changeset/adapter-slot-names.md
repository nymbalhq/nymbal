---
'@nymbalhq/payments-stripe': minor
'@nymbalhq/email-smtp': minor
'@nymbalhq/ai-anthropic': minor
'@nymbalhq/document-store-redis': minor
'@nymbalhq/document-store-postgres-jsonb': minor
'@nymbalhq/platform': minor
'nymbal': minor
---

Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
(from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
(from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.
