# Override Resolution

Nymbal must let a developer change their storefront and still take Nymbal patches without
merge conflicts. This document defines exactly how that works in v0.1: which layer wins,
where each layer comes from, and how to override any page.

## Resolution order

When `npx create-nymbal-app` scaffolds a project, files are resolved in this order
(later layers never overwrite earlier ones — the developer always ends up on top):

1. **Project files win — always.** Everything in the scaffolded project's `src/` belongs
   to the developer. At scaffold time, the project layer
   (`packages/create-app/scaffold/project/<template>/`) is overlaid on top of the template
   defaults, and project files win on every path collision. The shipped starter override —
   the homepage at `src/pages/index.astro`, sourced from
   `packages/create-app/scaffold/project/astro/src/pages/index.astro` — arrives through
   this layer. After scaffolding, every file in the project is the developer's to edit;
   Nymbal never ships a change that rewrites a scaffolded file in place.

2. **Template defaults are copied at scaffold time.** The default pages, layouts,
   components, and styles come from the canonical `@nymbal/template-astro` source
   (`templates/astro` in the monorepo; `templates/nextjs` for `@nymbal/template-nextjs`).
   At build time, `packages/create-app/scripts/sync-scaffold.mjs` syncs that source into
   `packages/create-app/scaffold/templates/<template>/`, and `create-nymbal-app` copies it
   into the new project. These files are a starting point, not a dependency — once
   scaffolded, they are project files (layer 1).

3. **Nymbal logic updates arrive as pure npm dependency bumps.** The platform kernel, SDK,
   interactive UI, shared types, and config schema live in versioned packages:
   `@nymbal/platform`, `@nymbal/sdk`, `@nymbal/web-components`, `@nymbal/types`,
   `@nymbal/config`. A Nymbal patch is `npm update` (or `pnpm update`) on those packages.
   Developer files and Nymbal package files never share a file, so taking a patch never
   merges. The scaffolded `src/` is a thin layer of markup that calls into these packages;
   the behaviour that needs patching (stores, components, API, security, config validation)
   ships inside them.

## How to override any page

The template source is the catalogue of defaults. To customise any page beyond the
homepage:

1. Find the default in the canonical template source — e.g.
   `templates/astro/src/pages/cart.astro` in
   [github.com/nymbalhq/nymbal](https://github.com/nymbalhq/nymbal).
2. Your scaffolded project already contains a copy at the same path
   (`src/pages/cart.astro`) — edit it directly. It is yours.
3. Keep the `data-testid` attributes intact if you want the stock E2E suite to keep
   passing against your store.

Because the whole `src/` tree is scaffolded into the project, "overriding" is simply
editing the file at the same route/name. There is no registration step and no detection
logic — same path = your version.

## Why the homepage ships as an override example

The homepage (`src/pages/index.astro` in an Astro project) is shipped from the project
layer (`scaffold/project/astro/`) rather than the template layer, and carries the marker
`<div hidden data-nymbal-marker="nymbal:project-override homepage"></div>` plus a visibly
customised section heading. (The marker is a real hidden element, not an HTML comment:
Astro's compiler strips bare comments adjacent to component invocations during SSR, so a
`<!-- … -->` marker would never reach the served HTML the scaffold-smoke job greps for.)
It exists so that:

- every fresh project demonstrates the override model working on day one — the first file
  a developer opens is already an example of "this file is mine, the template default was
  shadowed";
- the resolution order is continuously exercised in CI, not just documented. The
  scaffold-smoke job curls the running storefront and greps for the marker, proving the
  project layer won at runtime.

## The proof: the override guard test

The override model is guarded by tests in
`packages/create-app/test/scaffold.test.ts` (`override resolution (project layer wins)`):

- the scaffolded `src/pages/index.astro` must contain the
  `nymbal:project-override homepage` marker (project layer won);
- it must differ from the template default in
  `packages/create-app/scaffold/templates/astro/src/pages/index.astro`;
- a non-overridden page (`src/pages/cart.astro`) must be byte-identical to the template
  default;
- the `.astro` page files must actually exist (regression guard for the sync filter bug
  that once shipped a scaffold with zero `.astro` files).

If resolution ever breaks — the template default winning over a project file, or the
project layer being deleted by the scaffold sync — these tests fail. The CI
scaffold-smoke job additionally verifies the override end-to-end against a live dev
server for both the marker and the storefront markers (`hero-section`, `product-card-`).

## Design decision: scaffold-time overlay, not runtime route injection

A runtime model — installing `@nymbal/template-astro` as a dependency and injecting its
routes at dev/build time, with project files shadowing package routes — was considered
and rejected for v0.1. The project manual (CLAUDE.md) fixes the publishable package list
to: config, platform, sdk, web-components, react, types, contract-tests, test-factories.
The template packages are not in that list, so a template package cannot be an installed
npm dependency for scaffolded projects, and runtime route injection from it is not
possible. Instead, templates are synced into `create-nymbal-app` at build time and copied
into the project once, at scaffold time. Patchable behaviour ships in the publishable
packages (layer 3); the copied markup layer is intentionally thin and developer-owned.

The `scaffold/project/` directory lives outside `scaffold/templates/`, so the template
sync (`sync-scaffold.mjs`, which does `rm -rf` on `scaffold/templates/<name>` before
re-copying) can never delete the project-layer overrides.
