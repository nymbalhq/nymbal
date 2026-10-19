# nymbal

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 22b4523: Scaffold from a clean machine. `create-nymbal-app` installs by default (also with `--yes`; `--no-install` skips it),
  seeds through `nymbal seed`, pins every Nymbal package to one exact version with `@nymbalhq/stack`, `overrides` and
  `pnpm.overrides`, records `packageManager`, `.node-version` and `engine-strict`, and generates a config that uses native
  payments. The mobile prompt is gone. `nymbal seed` migrates first and is safe to run twice, every command loads the
  project's `.env`, `nymbal build` runs the project's local framework binary outside the monorepo, and `nymbal dev`
  tells the storefront to skip Stripe unless the configured provider is `stripe`.

### Patch Changes

- d12c7ec: The admin ships in the box: `nymbal dev` serves it at `/admin/`, create-nymbal-app's outro prints the admin credentials, a reload keeps the merchant signed in, and orders arrive live.
- e45d84d: Fix the headline `create-nymbal-app` → `nymbal dev` launch so a flat scaffold serves a live storefront with real demo content and zero external services.
  - `nymbal dev` now starts the storefront directly in the project root for a flat scaffold (detected by the framework config), instead of `pnpm --filter @nymbalhq/template-astro`, which matched the wrong package inside a workspace and nothing outside one.
  - The storefront port is now configurable (`--storefront-port` / `NYMBAL_STOREFRONT_PORT`) and falls through to the next free port when the default (4321 Astro / 3000 Next.js) is busy, so an unrelated project on the default port no longer blocks the launch. The free-port probe is IPv6-aware.
  - `resolveMigrations` no longer relies on `require.resolve('@nymbalhq/platform/package.json')` (the package's exports map is ESM-only and does not expose it), which previously broke auto-migrate in a scaffolded project ("Can't find meta/\_journal.json"). It now locates the installed package directory directly.
  - The Astro template honours `NYMBAL_STOREFRONT_PORT` (config-driven) so a bare `pnpm dev` degrades gracefully on a busy port, and the project-override homepage marker is rendered as a real (hidden) element so it survives SSR (Astro strips bare leading comments).

- e29919d: Honest storefront templates.
  - **SDK.** `client.customer.addresses.{list,create,remove}` and `client.customer.orders.{list,get}` call the account
    routes that exist, with the bearer token and the envelope unwrapped.
  - **Account pages.** Both templates' account pages now use these SDK calls, so a signed-in shopper sees their
    profile, addresses and orders. An order opens by its order number.
  - **Next.js template.** Sign Out revokes the session, a reload keeps a signed-in shopper signed in, and the account
    area can add an address.
  - **Search.** Choosing a search suggestion, by click or keyboard, opens the product on both templates.
  - **Upgrades.** The templates move to Astro 7 and Next 16 with React 19.
    - `@nymbalhq/react` now targets React 19 types: its peer range is `>=19`, and the generated JSX declarations augment
      `react` rather than the global namespace. That is breaking for React 18 consumers (pre-1.0, so a minor).
    - `nymbal dev` passes `--ignore-lock` to `astro dev`, so Astro 7 stays in the foreground when an AI agent runs it.
  - **Typecheck.** The root typecheck now runs `astro check`, and the scaffold is re-synced.
- Updated dependencies [d12c7ec]
- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [1743000]
- Updated dependencies [ccd3d36]
- Updated dependencies [ac2b2bb]
- Updated dependencies [edababa]
- Updated dependencies [22b4523]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e90bf2d]
  - @nymbalhq/admin@0.2.0
  - @nymbalhq/platform@0.2.0
  - @nymbalhq/types@0.2.0
  - @nymbalhq/importers@0.2.0
  - @nymbalhq/config@0.2.0
  - @nymbalhq/http@0.2.0
