# nymbal

## 1.5.0

### Minor Changes

- 6c85536: Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
  (from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
  (from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
  Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.
- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
- 5db4e1b: `nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
  (`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
  writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
- 39c852e: Commands print slots in kebab case (`document-store`, `event-bus`): doctor's checks, `nymbal dev` and `config:validate`; `test:contracts --slot` accepts either spelling.
  Breaking: a script reading `nymbal doctor --json` matches `primitive document-store` and `primitive event-bus` (and the same for `package`) now, in place of the camelCase names; `config:validate`'s summary says `command store:` in place of `commandStore:`.
- ca1a5f6: A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
  set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
  `http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
  rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
  Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
- bd75679: `nymbal add redis` and the other recipes work as before. `nymbal add <slot> <provider>` (as in `nymbal add media s3`)
  sets one slot, and `nymbal add <package>` adds a third-party adapter. Slots are named in kebab case (`document-store`).

### Patch Changes

- Updated dependencies [6c85536]
- Updated dependencies [f05e635]
- Updated dependencies [d2513b9]
- Updated dependencies [0b51500]
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
  - @nymbalhq/admin@1.5.0
  - @nymbalhq/http@1.5.0
  - @nymbalhq/importers@0.3.4

## 1.4.0

### Minor Changes

- d724fd2: Breaking in effect for your own handlers: a named handler that throws is now retried, up to five times over about 2.5 minutes, before its event is dead, so make it idempotent (for example with `withIdempotency`). `createApp` takes `relay` options for the attempts and the delay.
  Migration `0015` adds `events.retry_at`. `nymbal doctor` lists dead events, and `nymbal events query --json` prints `attempts` and `deadAt`.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.

### Patch Changes

- Updated dependencies [157e040]
- Updated dependencies [8e06b03]
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
  - @nymbalhq/admin@1.4.0
  - @nymbalhq/platform@1.4.0
  - @nymbalhq/types@1.4.0
  - @nymbalhq/http@1.4.0
  - @nymbalhq/importers@0.3.3
  - @nymbalhq/config@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/platform@1.3.0
  - @nymbalhq/types@1.3.0
  - @nymbalhq/admin@1.3.0
  - @nymbalhq/importers@0.3.2
  - @nymbalhq/config@1.3.0
  - @nymbalhq/http@1.3.0

## 1.2.0

- `nymbal audit export` and `nymbal events query|tail` read the store without changing it; `nymbal replay --to <model>`
  rebuilds a read model from the tables.
- `nymbal add cloudflare` and `nymbal security:plan|apply|drift|inspect` manage a Cloudflare zone's rules.
- `nymbal test:contracts --package <pkg>` certifies a third-party adapter against the published suites.
- `nymbal secrets rotate` and `nymbal secrets clear` manage the keys saved in the admin's Settings. `nymbal add stripe`
  no longer writes the Stripe secrets into the config.

## 1.1.0

- `nymbal dev` starts quietly with a one-screen summary (`--verbose` for debug logs).
- `nymbal doctor [--json]` checks the config, packages, command store, migrations, slots and primitives without changing
  anything.
- `nymbal add redis|postgres|s3|stripe` installs a service's packages and edits `nymbal.config.ts` and `.env.example`
  for it.
- `nymbal dev` passes the config's `adapters` export to the store, so a `custom` slot runs.
- `nymbal import` writes product images to the store's media storage.

## 1.0.0

- `nymbal dev` shuts down within 3 s, even with the admin open, and takes `--port <n>`.

## 0.2.0

- First release under `@nymbalhq`, as `nymbal`.
- `nymbal dev` serves the admin at `/admin/`.
- `nymbal seed` migrates first and is safe to run twice; every command loads the project's `.env`.
- `nymbal dev` keeps Astro 7 in the foreground (`--ignore-lock`).
