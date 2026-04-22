# Nymbal

Open source enterprise commerce platform.

## Quickstart

```bash
npx create-nymbal-app my-store
cd my-store
nymbal dev
```

Requires Node.js 22+ and pnpm 9+.

## Monorepo

```
packages/
  types/         @nymbal/types       — adapter contracts, shared types
  config/        @nymbal/config      — defineConfig(), validation, env()
  http/          @nymbal/http        — HTTP abstraction + Fastify adapter
  platform/     @nymbal/platform    — CQRS kernel (command + document + events)
  cli/           nymbal              — daily developer CLI
  create-app/    create-nymbal-app   — project scaffolder
templates/
  astro/         default storefront template
  nextjs/        migration-friendly template
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Type-check the whole workspace |
| `pnpm test` | Run unit tests (vitest) |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |

## License

MIT
