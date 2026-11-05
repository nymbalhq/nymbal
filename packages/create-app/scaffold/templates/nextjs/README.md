# Your Nymbal store

A commerce store made with [create-nymbal-app](https://github.com/nymbalhq/nymbal). Everything in this project is
yours to edit: `nymbal.config.ts`, and the pages, layouts and components under `src/`.

## Develop

```sh
npx nymbal dev
```

This serves the storefront at `http://localhost:3000`, the API on port 3001 and the admin at
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

| Script      | Runs                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------ |
| `dev`       | `next dev -p 3000`: the storefront alone, without the API (use `npx nymbal dev`)           |
| `build`     | `next build`: the storefront's production build                                            |
| `start`     | `next start -p 3000`: the built storefront alone (`npx nymbal start` runs the whole store) |
| `typecheck` | `tsc --noEmit`                                                                             |
| `migrate`   | `nymbal migrate`: apply database migrations                                                |
| `seed`      | `nymbal seed`: seed the demo content again                                                 |

Run them with your package manager (`npm run dev`, `pnpm dev`, …). `npx nymbal --help` lists every CLI command.

## Configuration

All configuration lives in `nymbal.config.ts`: the CLI, the API and the storefront read it. `npx nymbal doctor`
checks the project without changing anything, and `npx nymbal add` lists the providers and services you can add.

## Running behind a proxy

The API believes a forwarded client address (`X-Forwarded-For`) only from the proxies listed in
`NYMBAL_TRUSTED_PROXIES`: `loopback` by default, for a web server on the same machine. On your own server,
`npx nymbal deploy nginx` (or `apache`, `caddy`) writes a web server config with TLS that sets the header itself.
Behind a platform proxy, list its range (`NYMBAL_TRUSTED_PROXIES=uniquelocal` on Fly and Railway); otherwise every shopper
shares one rate-limit bucket, and `nymbal doctor` warns when the list is the default and `NYMBAL_PUBLIC_URL` is public.

## Help

Report a problem or ask a question at [github.com/nymbalhq/nymbal/issues](https://github.com/nymbalhq/nymbal/issues).
