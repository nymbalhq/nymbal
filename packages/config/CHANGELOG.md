# @nymbalhq/config

## 1.7.0

### Minor Changes

- 071e340: The admin's assistant sends a customer's email, phone, street lines and postcode to the AI provider as placeholders (`[email-1]`) and shows you the real values; choose the fields in `agents.assistant.mask` (`[]` turns it off). `nymbal doctor` names the AI host and what it receives.

### Patch Changes

- Updated dependencies [071e340]
  - @nymbalhq/types@1.7.0

## 1.6.0

### Minor Changes

- 0700627: Agentic checkout over ACP (beta, off by default): with `agents.acp.enabled` and `NYMBAL_ACP_API_KEY` set, a shopping agent opens a checkout session at `/api/acp` and pays with a delegated token (a Stripe Shared Payment Token) for a normal store order.
- 37d8f4a: Shipping adapters declare `rates`, `labels` and `tracking` and have only those methods (`rate`, `createLabel` and the new `startTracking` are optional; `track()` and `ShippingTracking` are removed; rate and label params and results are reshaped; native declares none), `GET /api/capabilities` reports `shipping`, and `runShippingContract` checks the words against the methods.
  A shipped order's tracking number is registered with a provider that declares `tracking`: `@nymbalhq/shipping-easypost` with an `apiKey` (which also rates and buys labels), or the new `@nymbalhq/shipping-aftership`.
  `store.shipFrom` sets the address the store ships from.
- 7cb17f1: An agent's admin write is now a proposal you approve or reject in the admin's new Inbox (`/admin/inbox`); approving runs it once, as you. Migration `0021_proposals` adds the table.
  `agents.autoApprove: ['product.update', …]` approves the commands it names at the call; a money command (`order.refund`, `order.markPaid`) cannot be listed and stops the store at boot, so only `agents.mcp.writes: 'apply'` runs those unasked.
  `admin_settings_put` is no longer an agent tool, and the client name an MCP agent sends in `_meta` is now kept on its proposals.
- 5d95ad2: A store answers shopping agents out of the box: a UCP 2026-08-25 profile at `/.well-known/ucp`, its catalogue search and checkout tools at `POST /api/ucp/mcp`, and a `continue_url` that hands the agent's cart to your checkout page.
  The API also serves `/robots.txt` (named AI crawlers allowed, shopper and admin paths kept out), `/llms.txt` and `/agents/products.json`.
  Set `agents.ucp.links` to your privacy and terms pages; `agents.ucp.enabled` and `agents.crawl` (`robots`, `llms`, `feed`, `allow`, `others`) turn each part off or change it.
- 5240c52: The API's routes are MCP tools for agents, at `POST /api/mcp` (bearer, no cookie) and through `nymbal mcp`, a stdio bridge an MCP host launches (`NYMBAL_MCP_URL`, `NYMBAL_MCP_TOKEN` or `NYMBAL_MCP_EMAIL`/`NYMBAL_MCP_PASSWORD`).
  A tool that runs a command only proposes it until you set `agents: { mcp: { writes: 'apply' } }`; `agents.mcp.enabled: false` turns the endpoint off.
  `@nymbalhq/http` now depends on the MCP TypeScript SDK, which brings Zod 4.
- 9d42cd4: The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
  `agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
  `nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.
- a4a8db6: The API runs on Fastify 5, drizzle-orm 0.45 and Zod 4. `FastifyHttpAdapter.registerPlugin` takes a Fastify 5 plugin, and `@nymbalhq/config` exports Zod 4 schemas.
  A DELETE sent with `Content-Type: application/json` and no body now answers 400.
- c9fe50b: Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
  With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
- ac55979: With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
  Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
  The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.
- 1a5b417: Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
  `nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
  `createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
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
  - @nymbalhq/types@1.6.0

## 1.5.0

### Minor Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
- 59e1639: New `easypost` shipping provider (`@nymbalhq/shipping-easypost`): set `shipping.provider: 'easypost'`, and its tracker
  webhooks (`/api/webhooks/easypost`) mark a shipped order delivered.
- ca1a5f6: A new store runs in production with no config edit: `NYMBAL_JWT_SECRET` (written into `.env` by `create-nymbal-app`,
  set as a platform secret by `nymbal deploy`) signs tokens when the config names no `security.auth.jwtSecret`.
  `http.trustProxy` takes a hop count, and `NYMBAL_TRUST_PROXY_HOPS` sets it at run time (the deploy recipes set 1), so
  rate limits key on the shopper behind the platform's proxy, not on the proxy or a forged `X-Forwarded-For`.
  Breaking: `registerAllRoutes` needs `jwtSecret` (`resolveAuthSecret(config, process.env).secret`).
- 95dad2e: New `mailgun` email provider (`@nymbalhq/email-mailgun`): it sends over Mailgun's SMTP relay, and its bounce and
  complaint webhooks stop alert mail to bad addresses. Set Mailgun's webhook URL to `/api/webhooks/mailgun`.
- c778b26: Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
  or asks for a new link. Signed-in shoppers go to their account's order page.

  Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
  makes every field the confirmation page does not show optional.

- a67f867: New `resend` email provider (`@nymbalhq/email-resend`): it sends over Resend's SMTP relay, and its bounce and
  complaint webhooks stop alert mail to bad addresses. Set Resend's webhook URL to `/api/webhooks/resend`.
- ab6c631: New `ses` email provider (`@nymbalhq/email-ses`): it sends over Amazon SES SMTP, and its SNS bounce and complaint
  notifications stop alert mail to bad addresses. Subscribe the SNS topic to `/api/webhooks/ses` over HTTPS.

### Patch Changes

- Updated dependencies [f05e635]
- Updated dependencies [0b51500]
- Updated dependencies [965b85a]
- Updated dependencies [c778b26]
- Updated dependencies [d9c8c5a]
- Updated dependencies [d0b44ed]
  - @nymbalhq/types@1.5.0

## 1.4.0

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

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- `security.adapter: 'cloudflare'` with `security.cloudflare` (`zoneId`, `apiToken`), `geo.block`, `customRules` and
  `managedRulesets`. **Breaking:** `'aws-waf'` and `'akamai'` now fail at start; use `middleware` or `cloudflare`.
- Every commerce slot block takes an optional `package`, for `nymbal test:contracts --package`.
- `events.retentionDays` (default 30) and `events.archive`; the archive bucket may not be the public media bucket.

## 1.1.0

- `infrastructure.documentStore`, `eventBus`, `redis` and `media` list only what is built. **Breaking:** delete
  `infrastructure.cloud` and `infrastructure.compute`; any unknown value or key now fails `loadConfig`.
- `infrastructure.media: 's3'` with an optional `infrastructure.s3` block. Credentials come from the AWS SDK's default
  chain, never the config.
- `loadConfig()` returns the config module's `adapters` export beside the config.

## 1.0.0

- **Breaking:** each slot's `provider` must be one of `KNOWN_PROVIDERS` or `custom`. Change `ai: { provider: 'native' }`
  to `'none'`, and SMTP mail to `email: { provider: 'smtp', config: { smtp } }`.

## 0.2.0

- First release under `@nymbalhq`.
- Built-in login and register rate limits sit under `security.rateLimit`. **Breaking:** `http.trustProxy` defaults to
  `false`; set it to `true` behind a proxy.
- `DEFAULT_JWT_SECRET` is exported, and a production store refuses to start with it.
