# Your Nymbal Store

A commerce project scaffolded with [create-nymbal-app](https://github.com/nymbal/nymbal).

## Scripts

```
pnpm dev         # nymbal dev — API + storefront
pnpm build       # nymbal build — production bundle
pnpm migrate     # nymbal migrate — run database migrations
pnpm seed        # nymbal seed — re-seed demo content
```

## Configuration

All configuration lives in `nymbal.config.ts`. Adapters, template, security, and deployment
settings are centralized there — the CLI and every package reads from the same source of truth.

## Swapping the command store

For local development you get SQLite out of the box. To move to Postgres:

1. Set `DATABASE_URL=postgres://…` in `.env`.
2. Change `infrastructure.commandStore` to `'postgres'` in `nymbal.config.ts`.
3. Run `pnpm migrate`.
