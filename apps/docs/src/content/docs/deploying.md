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
| `NYMBAL_ORIGIN_SECRET`                                                 | Optional: requests must cross your CDN ([below](#behind-cloudflare)).  |
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

## Behind Cloudflare

Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`
(`security.originLock.header`): anything else is `403 origin_locked`, before the rate limiter sees it. `/health`,
`/ready` and requests from the same machine stay open. With the Cloudflare adapter the API reads each shopper's address
from `CF-Connecting-IP` on those requests, so no proxy list is needed.

Point your domain through Cloudflare (proxied) and set `NYMBAL_PUBLIC_URL` in `.env` to it before the first deploy:
the lock refuses the platform's own host (`*.fly.dev`, `*.railway.app`), so `nymbal deploy fly` and `railway` refuse
it too. Give webhook providers and a storefront hosted elsewhere the same domain. Then, rule first and secret second:

```sh
npx nymbal security:apply
npx nymbal deploy fly
```

The first `security:apply` creates `NYMBAL_ORIGIN_SECRET` in `.env` once the zone holds the rule that sends it, and
prints the command that sets it on the host; the deploy steps set it from `.env`. The API token needs
Zone › Transform Rules › Edit beside its other scopes. `nymbal doctor` is down when the secret is set and the zone
does not send it.

- **Locked out** (every request 403): unset `NYMBAL_ORIGIN_SECRET` on the host and restart, then run
  `security:apply` again. On a second machine whose `.env` lacks the secret, `security:apply` refuses rather than
  replace the zone's; `npx nymbal security:apply --adopt-origin-secret` copies the zone's into `.env`, and
  `npx nymbal security:apply --new-origin-secret` replaces a compromised one (the host refuses traffic until it has the
  new value).
- **Rotating**: make `new` with `openssl rand -base64 32`, set the host to `new,old` and restart, run `security:apply`
  with `NYMBAL_ORIGIN_SECRET=new,old` (the edge now sends `new`), then set the host to `new`.

On your own server the web server is the lock instead: on a Cloudflare store `nymbal deploy nginx` admits only
Cloudflare's published ranges (below). The secret is harmless there, and makes the doctor line ok.

Anyone with Transform Rules read access on the zone can read the secret.

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
On a Cloudflare store the config admits only Cloudflare's published ranges, judged on the connection's own address, and
reads `CF-Connecting-IP` from them; the steps name the snapshot's date, and `nymbal security:drift` notes when
Cloudflare's ranges have changed since, so the file needs writing again with an updated adapter.
