# Your Nymbal Store

A commerce project scaffolded with [create-nymbal-app](https://github.com/nymbal/nymbal).

## Scripts

```
pnpm dev         # start Astro dev server
pnpm build       # production build
pnpm preview     # preview production build locally
pnpm migrate     # run database migrations
pnpm seed        # re-seed demo content
```

## Configuration

All configuration lives in `nymbal.config.ts`. Adapters, template, security, and deployment
settings are centralized there — the CLI and every package reads from the same source of truth.

## Swapping the command store

For local development you get SQLite out of the box. To move to Postgres:

1. Set `DATABASE_URL=postgres://…` in `.env`.
2. Change `infrastructure.commandStore` to `'postgres'` in `nymbal.config.ts`.
3. Run `pnpm migrate`.
