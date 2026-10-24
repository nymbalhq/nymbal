# @nymbalhq/stack

## 1.2.0

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [757150c]
- Updated dependencies [68d2358]
- Updated dependencies [b836370]
- Updated dependencies [5b89c81]
- Updated dependencies [1653d3f]
- Updated dependencies [a05b2e4]
- Updated dependencies [2d5ee9c]
- Updated dependencies [3591951]
- Updated dependencies [eaa120c]
- Updated dependencies [7d839a4]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
- Updated dependencies [94fcffd]
  - @nymbalhq/platform@1.2.0
  - @nymbalhq/types@1.2.0
  - @nymbalhq/http@1.2.0
  - nymbal@1.2.0
  - @nymbalhq/web-components@1.2.0
  - @nymbalhq/react@1.2.0
  - @nymbalhq/config@1.2.0
  - @nymbalhq/sdk@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [1b6da9e]
- Updated dependencies [ea74a39]
  - nymbal@1.1.0
  - @nymbalhq/platform@1.1.0
  - @nymbalhq/types@1.1.0
  - @nymbalhq/http@1.1.0
  - @nymbalhq/sdk@1.1.0
  - @nymbalhq/web-components@1.1.0
  - @nymbalhq/react@1.1.0
  - @nymbalhq/config@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [6571ce9]
- Updated dependencies [b1ef5ea]
  - @nymbalhq/platform@1.0.0
  - @nymbalhq/config@1.0.0
  - @nymbalhq/types@1.0.0
  - @nymbalhq/http@1.0.0
  - nymbal@1.0.0
  - @nymbalhq/react@1.0.0
  - @nymbalhq/sdk@1.0.0
  - @nymbalhq/web-components@1.0.0

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
