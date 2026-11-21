---
title: Upgrading
description: Move a store to a new Nymbal release by its one version number.
---

Nymbal's runtime packages are released together at one version, the version of `@nymbalhq/stack`. Your store pins
each of them to exactly that version in `package.json`, under `dependencies` and again under `overrides` (npm) and
`pnpm.overrides` (pnpm), so every package in the store is the combination that release was tested as. Your own files
never change in an upgrade: it is a version bump and an install.

1. Find the latest release:

   ```sh
   npm view @nymbalhq/stack version
   ```

2. In `package.json`, replace your current version (the one `@nymbalhq/stack` shows) with the new one everywhere it
   appears: the `nymbal` and `@nymbalhq/*` entries under `dependencies`, `overrides` and `pnpm.overrides`.

3. Install, apply any new migrations, and check:

   ```sh
   npm install
   npx nymbal migrate
   npx nymbal --version
   ```

   Use your package manager's install (`pnpm install`, `yarn`, `bun install`) if it is not npm.

Each release's notes list its migrations and anything you must change. Adapters (`@nymbalhq/payments-stripe` and the
rest) have versions of their own: update them as any other dependency.

## Check a store in CI

`nymbal verify` checks that this checkout still works as a store. It builds your storefront for production, then runs
a throwaway store beside the project with its own SQLite database, the built-in providers and the demo catalogue. Against
that store it loads the home and product pages and every script they name, places an order (cart, checkout, the order
confirmed and one unit of stock taken), and signs in to the admin to find the order. It needs no `.env`, no database
and no provider keys, never touches your own `nymbal.db`, and exits 1 at the first step that fails.

```sh
npx nymbal verify
```

Stores made with `create-nymbal-app` include a workflow, `nymbal.yml` in `.github/workflows`, which installs from your
lockfile and runs `nymbal verify` on every pull request and every push to `main`. An older store can add it there by
hand:

```yaml
name: Nymbal

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: npm
      - run: npm ci
      - run: npx nymbal verify
```

The workflow reads the Node version from `.node-version`: add that file (for example `22`) if your project has none.
`nymbal verify` loads your `nymbal.config.ts`, so an `env('X')` there with no default needs `X` set as a CI variable.
