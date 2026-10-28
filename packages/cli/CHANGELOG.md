# nymbal

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
