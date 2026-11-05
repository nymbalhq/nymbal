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

The API believes a forwarded client address (`X-Forwarded-For`) only when the connection comes from a proxy listed in
`NYMBAL_TRUSTED_PROXIES` (or `http.trustedProxies`): comma-separated `loopback`, `linklocal`, `uniquelocal`, addresses
or CIDRs, `loopback` by default. From any other address the connection's own address stands, and the first such request
logs a warning naming the address and the value to set. The Fly and Railway recipes set `uniquelocal`, where their
proxies connect from. `nymbal doctor` warns when the list is the default and `NYMBAL_PUBLIC_URL` is public: behind a
platform proxy every shopper would share one rate-limit bucket. A list holding every address (`0.0.0.0/0`) is refused.

A CDN that sends the client in one header (Cloudflare's `CF-Connecting-IP`, Akamai's `True-Client-IP`) can be read
with `NYMBAL_CLIENT_IP_HEADER` (or `http.clientIpHeader`), only from listed proxies. Use it only when every request to
the listed proxy passes through the CDN: a client that reaches the origin directly could set it.

## On your own server

```sh
npx nymbal deploy nginx
npx nymbal deploy apache
npx nymbal deploy caddy
```

Each writes a web server config (`deploy/nginx.conf`, `deploy/apache.conf` or `deploy/Caddyfile`) for the host in
`NYMBAL_PUBLIC_URL` and the API on `127.0.0.1:<PORT>`, and prints the steps to install it; it runs nothing. The config
serves TLS (Let's Encrypt through certbot for nginx and Apache, automatic for Caddy), redirects http to https,
compresses JSON and text but never the admin assistant's stream, caches nothing, and overwrites `X-Forwarded-For`,
`X-Real-IP` and `X-Forwarded-Proto` with what the web server saw, so the API keeps the `loopback` default. Behind a
CDN, `--real-ip-from <ranges>` and `--real-ip-header <name>` let the web server take the client from the CDN's header.
