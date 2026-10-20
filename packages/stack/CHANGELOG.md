# @nymbalhq/stack

## 0.2.0

### Minor Changes

- 22b4523: Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
  seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
  `pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
  payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
  project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
  tells the storefront to skip Stripe unless the configured provider is `stripe`.

### Patch Changes

- Updated dependencies [d12c7ec]
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [e45d84d]
- Updated dependencies [ccd3d36]
- Updated dependencies [ac2b2bb]
- Updated dependencies [edababa]
- Updated dependencies [22b4523]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e29919d]
- Updated dependencies [e90bf2d]
  - @nymbalhq/platform@0.2.0
  - nymbal@0.2.0
  - @nymbalhq/types@0.2.0
  - @nymbalhq/config@0.2.0
  - @nymbalhq/http@0.2.0
  - @nymbalhq/react@0.2.0
  - @nymbalhq/sdk@0.2.0
  - @nymbalhq/web-components@0.2.0
