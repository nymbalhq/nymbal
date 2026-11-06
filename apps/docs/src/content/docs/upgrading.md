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
