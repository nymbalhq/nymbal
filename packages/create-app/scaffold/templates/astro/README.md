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

## Running behind a proxy

When a reverse proxy, load balancer or tunnel sits in front of the store, set `NYMBAL_TRUST_PROXY_HOPS` to the
number of proxies in front (`NYMBAL_TRUST_PROXY_HOPS=1` for one). Without it every shopper arrives from the proxy's
address and shares one rate-limit bucket: `nymbal doctor` warns when the variable is missing and `NYMBAL_PUBLIC_URL`
is a public origin. Never use `http.trustProxy: true`: it lets any client choose its own address, and production
refuses to start with it.
