# @nymbalhq/config

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

- `security.adapter: 'cloudflare'` with `security.cloudflare` (`zoneId`, `apiToken`), `geo.block`, `customRules` and
  `managedRulesets`. **Breaking:** `'aws-waf'` and `'akamai'` now fail at start; use `middleware` or `cloudflare`.
- Every commerce slot block takes an optional `package`, for `nymbal test:contracts --package`.
- `events.retentionDays` (default 30) and `events.archive`; the archive bucket may not be the public media bucket.

## 1.1.0

- `infrastructure.documentStore`, `eventBus`, `redis` and `media` list only what is built. **Breaking:** delete
  `infrastructure.cloud` and `infrastructure.compute`; any unknown value or key now fails `loadConfig`.
- `infrastructure.media: 's3'` with an optional `infrastructure.s3` block. Credentials come from the AWS SDK's default
  chain, never the config.
- `loadConfig()` returns the config module's `adapters` export beside the config.

## 1.0.0

- **Breaking:** each slot's `provider` must be one of `KNOWN_PROVIDERS` or `custom`. Change `ai: { provider: 'native' }`
  to `'none'`, and SMTP mail to `email: { provider: 'smtp', config: { smtp } }`.

## 0.2.0

- First release under `@nymbalhq`.
- Built-in login and register rate limits sit under `security.rateLimit`. **Breaking:** `http.trustProxy` defaults to
  `false`; set it to `true` behind a proxy.
- `DEFAULT_JWT_SECRET` is exported, and a production store refuses to start with it.
