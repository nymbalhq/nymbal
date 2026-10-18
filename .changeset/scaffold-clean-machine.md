---
'nymbal': minor
'@nymbalhq/platform': minor
'@nymbalhq/stack': minor
'create-nymbal-app': minor
---

Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
`pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
tells the storefront to skip Stripe unless the configured provider is `stripe`.
