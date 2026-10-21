---
'nymbal': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/http': minor
'@nymbalhq/doc-store-redis': minor
'@nymbalhq/doc-store-postgres-jsonb': minor
'@nymbalhq/event-bus-redis-streams': minor
'@nymbalhq/media-s3': minor
---

`nymbal dev` starts quietly and says what is running, and `nymbal doctor` checks a project without changing it.

- `nymbal dev` logs at `info`: warnings, errors and notable events, not every projection. `--verbose` logs at debug,
  and `LOG_LEVEL`, when set, wins over the flag. Once the API is up (and the storefront started), it prints one
  summary: the store, the API, storefront and admin URLs, the command store, each commerce slot's provider and
  capabilities, and each primitive's provider. A Postgres URL is shown as `scheme://host:port/db`, never with its
  credentials. `event handlers registered`, `Warmed document store` and `HTTP server listening` now log at debug.
- `nymbal doctor [--json] [--timeout <ms>]` prints one line per check, `<ok|warn|down>  <name>  <detail>`: `config`,
  `package <slot>` for each provider that lives in its own package, `command store`, `migrations`, `slot <name>` for
  each commerce slot and `primitive <name>` for the document store, event bus and media. It exits 1 when any check is
  `down`, naming what and why; `warn` alone exits 0. `--json` prints `{ checks: [{ name, status, detail }] }`. It never
  migrates, seeds, writes a document, publishes, uploads or charges: SQLite is opened read-only and Postgres in
  read-only transactions, and no primitive is initialized. It never prints a secret from the config or the
  environment.
- `diagnose(config, { adapters?, logger?, timeoutMs? })` from `@nymbalhq/platform` is what doctor runs.
- `DocumentStoreAdapter`, `EventBusAdapter` and `MediaStorage` gain an optional `healthCheck?(): Promise<HealthReport>`,
  so a primitive written against the earlier interface still type-checks; doctor reports one without it as
  `no healthCheck`. Every bundled primitive implements it, bounded at 5 s: Redis and Redis Streams `PING`, Postgres
  JSONB a read (and `degraded` until its table exists), S3 `HeadBucket`, local-fs the root's write permission (never a
  write). `@nymbalhq/types` adds `HEALTH_CHECK_TIMEOUT_MS`, `boundedHealthCheck`, `connectionSecrets`, `displayUrl`,
  `errorText` and `SECRET_MIN_LENGTH` for implementing one.
- `createCommandStore` takes `readOnly: true` to open the store without changing it.
