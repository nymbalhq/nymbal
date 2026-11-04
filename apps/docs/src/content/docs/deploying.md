---
title: Deploying
description: The production image, nymbal start, the Fly and Railway recipes, and running behind a proxy.
---

In production a store is one container: `nymbal start` serves the API, the admin and the storefront on one port.
The [quickstart](../quickstart/) runs that container on your machine; a hosting platform runs the same image.

## Before the first deploy

`nymbal start` refuses two development defaults: the stub payments provider, which verifies no webhook signature, and
the default JWT secret, which the `.env` that `create-nymbal-app` writes already replaces. Add a real payments
provider, and Postgres so the store's data outlives the container when a deploy replaces it:

```sh
npx nymbal add stripe
npx nymbal add postgres
```

## The image

```sh
npx nymbal build --image
```

This writes a `Dockerfile` and a `.dockerignore` (when your project has none; edit them freely afterwards) and builds
the image: installed from your lockfile with the package manager your project records, built, and run as a non-root
user with `nymbal start` as its command. `--tag` names the image; arguments after `--` go to `docker build`.

## `nymbal start`

`nymbal start` checks its environment before it serves and lists every problem at once:

| Variable                                                               | When                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NYMBAL_PUBLIC_URL`                                                    | Always: the store's public origin, such as `https://shop.example.com`. |
| `NYMBAL_SECRETS_KEY`, `NYMBAL_JWT_SECRET`                              | Always: from your `.env`.                                              |
| `DATABASE_URL`                                                         | On Postgres.                                                           |
| `REDIS_URL`                                                            | On the Redis document store or event bus.                              |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` | On Stripe.                                                             |
| `PORT`                                                                 | Optional: the port to listen on (default 3001).                        |

Run `nymbal migrate` (and, for demo content, `nymbal seed`) against the database before the first start, or start with
`--migrate` on a single host. `GET /ready` answers 200 while the store takes traffic, and 503 while it drains or a
store it depends on is down. On `SIGTERM` the store stops taking new requests, finishes the ones in flight, and exits 0.

## Fly and Railway

```sh
npx nymbal deploy fly --dry-run
npx nymbal deploy railway --dry-run
```

Each writes the platform's file (`fly.toml` or `railway.json`: the Dockerfile build, a migrate step before each
release, the `/ready` health check, the drain time) and prints the steps it would run: the app, its Postgres and
Redis, the secrets from your `.env`, and the deploy. Without `--dry-run` it runs them with `flyctl` or `railway`, which
must be installed and logged in. Set your Stripe keys on the platform yourself, as its secrets.

## Behind a proxy

When a load balancer, CDN or tunnel sits in front of the store, set `NYMBAL_TRUST_PROXY_HOPS` to the number of proxies
in front (1 for one). Without it every shopper seems to come from the proxy and shares one rate-limit bucket;
`nymbal doctor` warns when it is missing on a public origin. Never set `http.trustProxy: true`: it lets any client
choose its own address, and production refuses to start with it. The Fly and Railway recipes set one hop.
