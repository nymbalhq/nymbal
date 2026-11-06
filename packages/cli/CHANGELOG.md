# nymbal

## 1.6.0

### Minor Changes

- 86ad196: Cmd-K in the admin has an Ask tab: the store's assistant answers from the store's own tools, and every write it wants is a proposal you approve or reject (only `agents.autoApprove` applies one at once). It needs an `ai` provider that can call tools.
  `nymbal eval assistant` asks it 20 golden questions with your key on a throwaway store and exits 0 at 17 or more.
- 00c2f07: Carts and orders record their `source`: `storefront`, `import`, or `agent:<name>` for one a shopping agent opened, kept through the buyer's sign-in. Migration `0022` adds the columns; existing rows read `storefront`.
  The admin dashboard gains an Agents tile (the last 30 days' agent orders and revenue, per agent, and the surfaces on), and an order's page names its source.
  `nymbal doctor` adds an `agents` line that warns when UCP checkout has no privacy or terms link in `agents.ucp.links`, or the public URL is plain http.
- 5d95ad2: A store answers shopping agents out of the box: a UCP 2026-08-25 profile at `/.well-known/ucp`, its catalogue search and checkout tools at `POST /api/ucp/mcp`, and a `continue_url` that hands the agent's cart to your checkout page.
  The API also serves `/robots.txt` (named AI crawlers allowed, shopper and admin paths kept out), `/llms.txt` and `/agents/products.json`.
  Set `agents.ucp.links` to your privacy and terms pages; `agents.ucp.enabled` and `agents.crawl` (`robots`, `llms`, `feed`, `allow`, `others`) turn each part off or change it.
- 5240c52: The API's routes are MCP tools for agents, at `POST /api/mcp` (bearer, no cookie) and through `nymbal mcp`, a stdio bridge an MCP host launches (`NYMBAL_MCP_URL`, `NYMBAL_MCP_TOKEN` or `NYMBAL_MCP_EMAIL`/`NYMBAL_MCP_PASSWORD`).
  A tool that runs a command only proposes it until you set `agents: { mcp: { writes: 'apply' } }`; `agents.mcp.enabled: false` turns the endpoint off.
  `@nymbalhq/http` now depends on the MCP TypeScript SDK, which brings Zod 4.
- 9d42cd4: The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
  `agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
  `nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.
- 2efa507: `nymbal import` charges WooCommerce's sale prices with the regular price as compare-at, keeps counted stock (untracked items at `--untracked-stock`, default 1000), reads weights, sizes and prices in the store's own units and currency, and refuses a store in another currency. Grouped, external and price-less products arrive as drafts; tags, attributes, tax and shipping classes and public custom fields stay in `metadata.woocommerce`, also after AI enrichment.
  What could not be carried over exactly is listed under "Review before launch" in the migration report.
- a8cca3d: `nymbal import --dry-run` reads the WooCommerce store and writes `nymbal-import-plan.json` and `.md`: what the import would create, refuse and skip, slug, SKU and order-number clashes with the source or your store, the fields it never reads, a time estimate and what does not migrate. It imports nothing and opens your store read-only.
- 2fbb296: `nymbal import --rollback` removes every record your imports created (customers that already had an account stay) and refuses once the store has orders or reviews of its own; `--yes` skips the question. Media files are kept.
  The import's state file is saved atomically with a journal beside it, so a stopped import or rollback loses nothing, and an unreadable state file stops `nymbal import` instead of starting again. `--fresh` keeps what earlier runs created.
  New: `order.deleted.v1`, and `services.importRemoval`.
- 0a940fa: `nymbal import --since last` (or `--since <date>`) brings over what changed in WooCommerce since your last import: new products, customers, orders and reviews are created, and imported products take their new names, copy, images and prices (stock is left alone). An imported order that changed is counted, not rewritten; the report gains a "Changes since" section.
  `@nymbalhq/importers` exports `resolveSince` and `ImportSinceError`.
- 73c9738: `nymbal preview --source woocommerce --url … --key … --secret …` imports your WooCommerce store into a throwaway store and serves it on your storefront, and writes `nymbal-preview-report.{json,md}` (counts, differences, drafts) and `nymbal-redirects.csv`; your own store is not touched. A store already scaffolded copies `src/lib/page-policy.ts` (Astro) or `lib/page-policy.mjs` (Next.js) so images load from the API's origin.

  `nymbal import`: of two products whose slugs clash, the first in WooCommerce keeps the slug.

- c9fe50b: Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
  With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
- ec1e87b: Breaking for new stores: both storefront templates send a content security policy (`pagePolicy` in `lib/page-policy`), which refuses framing the store, http images and any third-party script, font, pixel, browser-side call or form target (analytics, chat, Google Fonts) until you add it there. `nymbal start` adds HSTS (https only), `nosniff`, `X-Frame-Options`, a `Referrer-Policy` and a minimal policy to any page that sets none.
  The shopper's access token now stays in page memory: `client.auth.restore()` brings the session back from the refresh cookie on each page load, guests send nothing, and requests made meanwhile wait for it. A token an earlier version left in `localStorage` is removed and its shopper stays signed in.
  A client built on `@nymbalhq/sdk/core`, as the Astro template's is, calls `resumeSession(client)` from `@nymbalhq/sdk/core` once per page load before its first request; a store that keeps its own older `lib/client.ts` must add it.
- b8d68df: `nymbal preview --lighthouse` builds your storefront for production and compares Lighthouse scores (median of `--lighthouse-runs`, default 3) of your WooCommerce home, a product and a category with the same pages in the preview, in a `## Lighthouse` section of the report. Install `lighthouse@^12` in the project, or point `NYMBAL_LIGHTHOUSE_CLI` at one; Chrome is needed.
- c52ac10: Failed logins for an email from other addresses no longer lock its owner out (each address still is); checkouts behind one address count per cart, up to 300 a minute per address; no-JS order and alert requests sent through `nymbal start` count against the shopper, except across several API processes, where they share the storefront's.
  `create-nymbal-app` asks for the admin email (`--admin-email` with `--yes`) and otherwise draws a random one.
- 1a5b417: Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
  `nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
  `createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.

### Patch Changes

- 366760e: `nymbal add` run again after you added your own key beside the block a recipe wrote is a no-op, not a conflict.
- 366760e: `nymbal add` checks the edited config with every `.env` value applied, as `nymbal dev` loads them, so a bad value read through `envNumber()` or `process.env` is caught before the config is written.
- d2277af: `nymbal import` names each product image it could not bring over, with why (an HTTP status, a timeout, an unsupported type or a refused address), under "Media" in the migration report, and still imports the product with its other images. The report groups errors and review items by phase with counts, and the summary says "AI enrichment: off" when no AI provider is set.
- 2be0e86: `nymbal import --gdpr` keeps no buyer's name, email, phone, street, postcode or note on imported orders, and no import emails your customers. Imported orders keep their variant, line tax, fees and partial refunds, in the order currency's own minor units.
  A stopped import run again holds each order once and its progress ends at n/n; `--entities orders` after `--entities products` imports the orders. `customer.created.v1` gains `origin: 'import'`.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- ac55979: With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
  Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
  The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.
- Updated dependencies [0700627]
- Updated dependencies [37d8f4a]
- Updated dependencies [86ad196]
- Updated dependencies [07ff236]
- Updated dependencies [040f754]
- Updated dependencies [2778182]
- Updated dependencies [00c2f07]
- Updated dependencies [7cb17f1]
- Updated dependencies [5d95ad2]
- Updated dependencies [5240c52]
- Updated dependencies [d441055]
- Updated dependencies [061bc68]
- Updated dependencies [12e3285]
- Updated dependencies [9d42cd4]
- Updated dependencies [07ff236]
- Updated dependencies [7a136c9]
- Updated dependencies [7a136c9]
- Updated dependencies [07ff236]
- Updated dependencies [040f754]
- Updated dependencies [a4a8db6]
- Updated dependencies [366760e]
- Updated dependencies [424c8f0]
- Updated dependencies [2efa507]
- Updated dependencies [a8cca3d]
- Updated dependencies [d2277af]
- Updated dependencies [2be0e86]
- Updated dependencies [2fbb296]
- Updated dependencies [0a940fa]
- Updated dependencies [73c9738]
- Updated dependencies [454e12a]
- Updated dependencies [c9fe50b]
- Updated dependencies [853d563]
- Updated dependencies [ec1e87b]
- Updated dependencies [b8d68df]
- Updated dependencies [c52ac10]
- Updated dependencies [13a6b2d]
- Updated dependencies [41ef49d]
- Updated dependencies [f2c9a19]
- Updated dependencies [ac55979]
- Updated dependencies [07ff236]
- Updated dependencies [402a5d1]
- Updated dependencies [2778182]
- Updated dependencies [1a5b417]
  - @nymbalhq/platform@1.6.0
  - @nymbalhq/config@1.6.0
  - @nymbalhq/types@1.6.0
  - @nymbalhq/http@1.6.0
  - @nymbalhq/admin@1.6.0
  - @nymbalhq/importers@0.4.0

## 1.5.0

### Minor Changes

- 6c85536: Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
  (from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
  (from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
  Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.
- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
- 5db4e1b: `nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
  (`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
  writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
- 39c852e: Commands print slots in kebab case (`document-store`, `event-bus`): doctor's checks, `nymbal dev` and `config:validate`; `test:contracts --slot` accepts either spelling.
  Breaking: a script reading `nymbal doctor --json` matches `primitive document-store` and `primitive event-bus` (and the same for `package`) now, in place of the camelCase names; `config:validate`'s summary says `command store:` in place of `commandStore:`.
- ca1a5f6: A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
  set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
  `http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
  rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
  Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
- bd75679: `nymbal add redis` and the other recipes work as before. `nymbal add <slot> <provider>` (as in `nymbal add media s3`)
  sets one slot, and `nymbal add <package>` adds a third-party adapter. Slots are named in kebab case (`document-store`).

### Patch Changes

- Updated dependencies [6c85536]
- Updated dependencies [f05e635]
- Updated dependencies [d2513b9]
- Updated dependencies [0b51500]
- Updated dependencies [0b51500]
- Updated dependencies [bb453b8]
- Updated dependencies [5db4e1b]
- Updated dependencies [39c852e]
- Updated dependencies [eed87ad]
- Updated dependencies [59e1639]
- Updated dependencies [965b85a]
- Updated dependencies [ca1a5f6]
- Updated dependencies [95dad2e]
- Updated dependencies [733d4b1]
- Updated dependencies [c778b26]
- Updated dependencies [0b51500]
- Updated dependencies [86724f2]
- Updated dependencies [a67f867]
- Updated dependencies [ab6c631]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
  - @nymbalhq/platform@1.5.0
  - @nymbalhq/config@1.5.0
  - @nymbalhq/types@1.5.0
  - @nymbalhq/admin@1.5.0
  - @nymbalhq/http@1.5.0
  - @nymbalhq/importers@0.3.4

## 1.4.0

### Minor Changes

- d724fd2: Breaking in effect for your own handlers: a named handler that throws is now retried, up to five times over about 2.5 minutes, before its event is dead, so make it idempotent (for example with `withIdempotency`). `createApp` takes `relay` options for the attempts and the delay.
  Migration `0015` adds `events.retry_at`. `nymbal doctor` lists dead events, and `nymbal events query --json` prints `attempts` and `deadAt`.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.

### Patch Changes

- Updated dependencies [157e040]
- Updated dependencies [8e06b03]
- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [d724fd2]
- Updated dependencies [63ede12]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [d546cd3]
- Updated dependencies [d546cd3]
- Updated dependencies [dbf1425]
- Updated dependencies [ea1926d]
- Updated dependencies [c8588b2]
  - @nymbalhq/admin@1.4.0
  - @nymbalhq/platform@1.4.0
  - @nymbalhq/types@1.4.0
  - @nymbalhq/http@1.4.0
  - @nymbalhq/importers@0.3.3
  - @nymbalhq/config@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/platform@1.3.0
  - @nymbalhq/types@1.3.0
  - @nymbalhq/admin@1.3.0
  - @nymbalhq/importers@0.3.2
  - @nymbalhq/config@1.3.0
  - @nymbalhq/http@1.3.0

## 1.2.0

- `nymbal audit export` and `nymbal events query|tail` read the store without changing it; `nymbal replay --to <model>`
  rebuilds a read model from the tables.
- `nymbal add cloudflare` and `nymbal security:plan|apply|drift|inspect` manage a Cloudflare zone's rules.
- `nymbal test:contracts --package <pkg>` certifies a third-party adapter against the published suites.
- `nymbal secrets rotate` and `nymbal secrets clear` manage the keys saved in the admin's Settings. `nymbal add stripe`
  no longer writes the Stripe secrets into the config.

## 1.1.0

- `nymbal dev` starts quietly with a one-screen summary (`--verbose` for debug logs).
- `nymbal doctor [--json]` checks the config, packages, command store, migrations, slots and primitives without changing
  anything.
- `nymbal add redis|postgres|s3|stripe` installs a service's packages and edits `nymbal.config.ts` and `.env.example`
  for it.
- `nymbal dev` passes the config's `adapters` export to the store, so a `custom` slot runs.
- `nymbal import` writes product images to the store's media storage.

## 1.0.0

- `nymbal dev` shuts down within 3 s, even with the admin open, and takes `--port <n>`.

## 0.2.0

- First release under `@nymbalhq`, as `nymbal`.
- `nymbal dev` serves the admin at `/admin/`.
- `nymbal seed` migrates first and is safe to run twice; every command loads the project's `.env`.
- `nymbal dev` keeps Astro 7 in the foreground (`--ignore-lock`).
