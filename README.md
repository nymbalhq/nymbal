# Nymbal

Open source enterprise commerce platform. CQRS, event-driven, adapter-everything —
a real store running locally in under five minutes with zero external infrastructure.

## Quickstart

```bash
npx create-nymbal-app my-store
cd my-store
nymbal dev
```

That's it: `nymbal dev` migrates the local SQLite database, seeds realistic demo content on
first run, warms the read models, starts the platform API on port 3001 and the Astro
storefront on port 4321 — no Docker, no cloud accounts, no API keys.

Requires Node.js 22+ and pnpm 9+.

## Your store vs. Nymbal updates

The scaffolded project is split so that taking a Nymbal patch never causes a merge conflict:

- **Yours:** everything `create-nymbal-app` puts in your project — `nymbal.config.ts` and the
  thin `src/` layer (Astro pages, layouts, components). Restyle pages, add routes, delete what
  you don't want. One page (the homepage) ships pre-overridden as a working example.
- **Nymbal's:** the engine — `@nymbal/platform`, `@nymbal/sdk`, `@nymbal/web-components`,
  `@nymbal/types`, `@nymbal/config` — installed as versioned npm packages. A Nymbal patch is a
  dependency bump:

  ```bash
  pnpm update @nymbal/platform @nymbal/sdk @nymbal/web-components @nymbal/types @nymbal/config
  ```

Developer files and Nymbal package files never share a file, so there is nothing to merge.
See [OVERRIDES.md](./OVERRIDES.md) for the exact override/resolution order.

## Monorepo

```
packages/
  types/            @nymbal/types          — adapter contracts, shared types (single source of truth)
  config/           @nymbal/config         — defineConfig(), Zod schema, env()
  platform/         @nymbal/platform       — CQRS kernel (command store, document store, event bus, services)
  sdk/              @nymbal/sdk            — framework-agnostic client stores + CommerceAdapter
  web-components/   @nymbal/web-components — interactive storefront UI (source of truth)
  react/            @nymbal/react          — hooks + generated wrappers for the web components
  http/             @nymbal/http           — HTTP abstraction + Fastify adapter (internal)
  importers/        @nymbal/importers      — WooCommerce migration engine (internal)
  contract-tests/   @nymbal/contract-tests — adapter certification suites
  test-factories/   @nymbal/test-factories — typed test data factories
  cli/              nymbal                 — dev / build / migrate / seed / import / config-validate
  create-app/       create-nymbal-app      — project scaffolder
templates/
  astro/            default storefront template (performance-first)
  nextjs/           migration-friendly template
apps/
  admin/            admin dashboard (React SPA)
tests/
  e2e/              Playwright journeys, visual regression, a11y
  contracts/        adapter contract test runs
  architecture/     architecture guard (no rendering frameworks in the kernel)
```

## Migrating from WooCommerce

```bash
nymbal import --source woocommerce --url https://mystore.com --key ck_… --secret cs_…
```

Maps products, categories, customers and orders onto the Nymbal schema, anonymises PII by
default, enriches missing fields through the `AIAdapter` contract, resumes after interruption,
and writes a migration report (imported / skipped / needs-review).

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check the whole workspace |
| `pnpm test` | Run unit + integration tests (vitest) |
| `pnpm vitest run --coverage` | Tests with coverage gates (services: 100% branch) |
| `pnpm --filter @nymbal/e2e exec playwright test` | E2E journeys (astro / nextjs / admin projects) |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |

## License

MIT
