# nymbal

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
