# @nymbalhq/http

## 1.6.0

### Minor Changes

- 0700627: Agentic checkout over ACP (beta, off by default): with `agents.acp.enabled` and `NYMBAL_ACP_API_KEY` set, a shopping agent opens a checkout session at `/api/acp` and pays with a delegated token (a Stripe Shared Payment Token) for a normal store order.
- 5d95ad2: A store answers shopping agents out of the box: a UCP 2026-08-25 profile at `/.well-known/ucp`, its catalogue search and checkout tools at `POST /api/ucp/mcp`, and a `continue_url` that hands the agent's cart to your checkout page.
  The API also serves `/robots.txt` (named AI crawlers allowed, shopper and admin paths kept out), `/llms.txt` and `/agents/products.json`.
  Set `agents.ucp.links` to your privacy and terms pages; `agents.ucp.enabled` and `agents.crawl` (`robots`, `llms`, `feed`, `allow`, `others`) turn each part off or change it.
- 5240c52: The API's routes are MCP tools for agents, at `POST /api/mcp` (bearer, no cookie) and through `nymbal mcp`, a stdio bridge an MCP host launches (`NYMBAL_MCP_URL`, `NYMBAL_MCP_TOKEN` or `NYMBAL_MCP_EMAIL`/`NYMBAL_MCP_PASSWORD`).
  A tool that runs a command only proposes it until you set `agents: { mcp: { writes: 'apply' } }`; `agents.mcp.enabled: false` turns the endpoint off.
  `@nymbalhq/http` now depends on the MCP TypeScript SDK, which brings Zod 4.
- a4a8db6: The API runs on Fastify 5, drizzle-orm 0.45 and Zod 4. `FastifyHttpAdapter.registerPlugin` takes a Fastify 5 plugin, and `@nymbalhq/config` exports Zod 4 schemas.
  A DELETE sent with `Content-Type: application/json` and no body now answers 400.
- c9fe50b: Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
  With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
- ec1e87b: Breaking for new stores: both storefront templates send a content security policy (`pagePolicy` in `lib/page-policy`), which refuses framing the store, http images and any third-party script, font, pixel, browser-side call or form target (analytics, chat, Google Fonts) until you add it there. `nymbal start` adds HSTS (https only), `nosniff`, `X-Frame-Options`, a `Referrer-Policy` and a minimal policy to any page that sets none.
  The shopper's access token now stays in page memory: `client.auth.restore()` brings the session back from the refresh cookie on each page load, guests send nothing, and requests made meanwhile wait for it. A token an earlier version left in `localStorage` is removed and its shopper stays signed in.
  A client built on `@nymbalhq/sdk/core`, as the Astro template's is, calls `resumeSession(client)` from `@nymbalhq/sdk/core` once per page load before its first request; a store that keeps its own older `lib/client.ts` must add it.
- c52ac10: Failed logins for an email from other addresses no longer lock its owner out (each address still is); checkouts behind one address count per cart, up to 300 a minute per address; no-JS order and alert requests sent through `nymbal start` count against the shopper, except across several API processes, where they share the storefront's.
  `create-nymbal-app` asks for the admin email (`--admin-email` with `--yes`) and otherwise draws a random one.
- f2c9a19: Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
  Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
- 1a5b417: Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
  `nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
  `createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.

### Patch Changes

- 7cb17f1: An agent's admin write is now a proposal you approve or reject in the admin's new Inbox (`/admin/inbox`); approving runs it once, as you. Migration `0021_proposals` adds the table.
  `agents.autoApprove: ['product.update', …]` approves the commands it names at the call; a money command (`order.refund`, `order.markPaid`) cannot be listed and stops the store at boot, so only `agents.mcp.writes: 'apply'` runs those unasked.
  `admin_settings_put` is no longer an agent tool, and the client name an MCP agent sends in `_meta` is now kept on its proposals.
- 07ff236: Only `GET /api/csrf` sets the `nymbal.csrf` cookie, so a guest's first parallel requests no longer leave it different from the token; a client of your own fetches `GET /api/csrf` before its first write. API answers that set no caching of their own now say `Cache-Control: no-store`.
- 424c8f0: `@fastify/cors` 11.4.0, `@fastify/http-proxy` 11.6.6 and `@fastify/reply-from` 12.8.1, the security releases of 2026-11-02.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- ac55979: With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
  Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
  The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.
- Updated dependencies [0700627]
- Updated dependencies [37d8f4a]
- Updated dependencies [86ad196]
- Updated dependencies [00c2f07]
- Updated dependencies [7cb17f1]
- Updated dependencies [5d95ad2]
- Updated dependencies [5240c52]
- Updated dependencies [d441055]
- Updated dependencies [061bc68]
- Updated dependencies [12e3285]
- Updated dependencies [9d42cd4]
- Updated dependencies [7a136c9]
- Updated dependencies [a4a8db6]
- Updated dependencies [2be0e86]
- Updated dependencies [2fbb296]
- Updated dependencies [c9fe50b]
- Updated dependencies [853d563]
- Updated dependencies [c52ac10]
- Updated dependencies [13a6b2d]
- Updated dependencies [f2c9a19]
- Updated dependencies [ac55979]
- Updated dependencies [07ff236]
- Updated dependencies [402a5d1]
- Updated dependencies [1a5b417]
  - @nymbalhq/config@1.6.0
  - @nymbalhq/types@1.6.0

## 1.5.0

### Minor Changes

- 5db4e1b: `nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
  (`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
  writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
- ca1a5f6: A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
  set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
  `http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
  rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
  Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
- c778b26: Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
  or asks for a new link. Signed-in shoppers go to their account's order page.

  Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
  makes every field the confirmation page does not show optional.

### Patch Changes

- Updated dependencies [f05e635]
- Updated dependencies [0b51500]
- Updated dependencies [bb453b8]
- Updated dependencies [59e1639]
- Updated dependencies [965b85a]
- Updated dependencies [ca1a5f6]
- Updated dependencies [95dad2e]
- Updated dependencies [c778b26]
- Updated dependencies [a67f867]
- Updated dependencies [ab6c631]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
  - @nymbalhq/config@1.5.0
  - @nymbalhq/types@1.5.0

## 1.4.0

### Minor Changes

- 295dab6: Back-in-stock alerts: `POST /api/alerts/subscribe` emails a confirmation, and `/api/alerts/confirm` and `/api/alerts/unsubscribe` take the token from its links. A variant whose stock rises from 0 publishes `product.restocked.v1`, and each confirmed subscriber gets one email. Adds the `alert_subscriptions` migration; subscribe is limited to 10 per IP per hour and answers 409 on a store whose email is `native`.
  `GET /api/capabilities` reports `email.delivers`.
  Breaking for a kernel composed by hand: `buildServices` now takes `email` (the email adapter), `registerHandlers` takes `alerts` (the alert service), and `registerCapabilitiesRoute` needs `adapters.email`.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0
  - @nymbalhq/config@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 1.2.0

- Every response carries `x-correlation-id`, Fastify's own 404 and 400 included.
- CORS exposes `x-correlation-id` and `Idempotent-Replayed`.

## 1.1.0

- The listening line logs at debug.

## 1.0.0

- `stop()` ends open event streams and closes their connections, so stopping the store no longer hangs with the admin
  open.

## 0.2.0

- First release under `@nymbalhq`.
- Every route passes one CSRF and rate-limit guard before auth. **Breaking:** `trustProxy` defaults to `false`.
- Routes registered with `rawBody: true` keep the exact request bytes, for webhook signatures.
