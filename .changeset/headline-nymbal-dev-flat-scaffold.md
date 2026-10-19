---
nymbal: patch
---

Fix the headline `create-nymbal-app` → `nymbal dev` launch so a flat scaffold serves a live storefront with real demo content and zero external services.

- `nymbal dev` now starts the storefront directly in the project root for a flat scaffold (detected by the framework config), instead of `pnpm --filter @nymbalhq/template-astro`, which matched the wrong package inside a workspace and nothing outside one.
- The storefront port is now configurable (`--storefront-port` / `NYMBAL_STOREFRONT_PORT`) and falls through to the next free port when the default (4321 Astro / 3000 Next.js) is busy, so an unrelated project on the default port no longer blocks the launch. The free-port probe is IPv6-aware.
- `resolveMigrations` no longer relies on `require.resolve('@nymbalhq/platform/package.json')` (the package's exports map is ESM-only and does not expose it), which previously broke auto-migrate in a scaffolded project ("Can't find meta/\_journal.json"). It now locates the installed package directory directly.
- The Astro template honours `NYMBAL_STOREFRONT_PORT` (config-driven) so a bare `pnpm dev` degrades gracefully on a busy port, and the project-override homepage marker is rendered as a real (hidden) element so it survives SSR (Astro strips bare leading comments).
