# Your Nymbal store

A commerce store made with [create-nymbal-app](https://github.com/nymbalhq/nymbal). Everything in this project is
yours to edit: `nymbal.config.ts`, and the pages, layouts and components under `src/`.

## Develop

```sh
npx nymbal dev
```

This serves the storefront at `http://localhost:4321`, the API on port 3001 and the admin at
`http://localhost:3001/admin/` (its email and password are in `.env`). It runs on SQLite with stub payments, and seeds
demo products on the first run.

## Production

Production runs on Postgres and takes payments through Stripe. Add both, then build the store's image:

```sh
npx nymbal add postgres
npx nymbal add stripe
npx nymbal build --image
```

The image runs `nymbal start`: the API, the admin and the storefront on one port. `npx nymbal deploy fly` and
`npx nymbal deploy railway` deploy it (`--dry-run` shows the steps first). The
[quickstart](https://github.com/nymbalhq/nymbal/blob/main/apps/docs/src/content/docs/quickstart.md) runs it locally with
an AI agent connected, and [Deploying](https://github.com/nymbalhq/nymbal/blob/main/apps/docs/src/content/docs/deploying.md)
covers the environment it needs.

## Scripts

| Script      | Runs                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `dev`       | `astro dev`: the storefront alone, without the API (use `npx nymbal dev`) |
| `build`     | `astro build`: the storefront's production build                          |
| `preview`   | `astro preview`: the built storefront                                     |
| `typecheck` | `astro check`                                                             |
| `migrate`   | `nymbal migrate`: apply database migrations                               |
| `seed`      | `nymbal seed`: seed the demo content again                                |

Run them with your package manager (`npm run dev`, `pnpm dev`, …). `npx nymbal --help` lists every CLI command.

## Configuration

All configuration lives in `nymbal.config.ts`: the CLI, the API and the storefront read it. `npx nymbal doctor`
checks the project without changing anything, and `npx nymbal add` lists the providers and services you can add.

## Running behind a proxy

When a reverse proxy, load balancer or tunnel sits in front of the store, set `NYMBAL_TRUST_PROXY_HOPS` to the
number of proxies in front (`NYMBAL_TRUST_PROXY_HOPS=1` for one). Without it every shopper arrives from the proxy's
address and shares one rate-limit bucket: `nymbal doctor` warns when the variable is missing and `NYMBAL_PUBLIC_URL`
is a public origin. Never use `http.trustProxy: true`: it lets any client choose its own address, and production
refuses to start with it.

## Help

Report a problem or ask a question at [github.com/nymbalhq/nymbal/issues](https://github.com/nymbalhq/nymbal/issues).
