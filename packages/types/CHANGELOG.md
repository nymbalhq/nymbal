# @nymbalhq/types

## 1.6.0

### Minor Changes

- 0700627: Agentic checkout over ACP (beta, off by default): with `agents.acp.enabled` and `NYMBAL_ACP_API_KEY` set, a shopping agent opens a checkout session at `/api/acp` and pays with a delegated token (a Stripe Shared Payment Token) for a normal store order.
- 37d8f4a: Shipping adapters declare `rates`, `labels` and `tracking` and have only those methods (`rate`, `createLabel` and the new `startTracking` are optional; `track()` and `ShippingTracking` are removed; rate and label params and results are reshaped; native declares none), `GET /api/capabilities` reports `shipping`, and `runShippingContract` checks the words against the methods.
  A shipped order's tracking number is registered with a provider that declares `tracking`: `@nymbalhq/shipping-easypost` with an `apiKey` (which also rates and buys labels), or the new `@nymbalhq/shipping-aftership`.
  `store.shipFrom` sets the address the store ships from.
- 86ad196: Cmd-K in the admin has an Ask tab: the store's assistant answers from the store's own tools, and every write it wants is a proposal you approve or reject (only `agents.autoApprove` applies one at once). It needs an `ai` provider that can call tools.
  `nymbal eval assistant` asks it 20 golden questions with your key on a throwaway store and exits 0 at 17 or more.
- 00c2f07: Carts and orders record their `source`: `storefront`, `import`, or `agent:<name>` for one a shopping agent opened, kept through the buyer's sign-in. Migration `0022` adds the columns; existing rows read `storefront`.
  The admin dashboard gains an Agents tile (the last 30 days' agent orders and revenue, per agent, and the surfaces on), and an order's page names its source.
  `nymbal doctor` adds an `agents` line that warns when UCP checkout has no privacy or terms link in `agents.ucp.links`, or the public URL is plain http.
- 7cb17f1: An agent's admin write is now a proposal you approve or reject in the admin's new Inbox (`/admin/inbox`); approving runs it once, as you. Migration `0021_proposals` adds the table.
  `agents.autoApprove: ['product.update', …]` approves the commands it names at the call; a money command (`order.refund`, `order.markPaid`) cannot be listed and stops the store at boot, so only `agents.mcp.writes: 'apply'` runs those unasked.
  `admin_settings_put` is no longer an agent tool, and the client name an MCP agent sends in `_meta` is now kept on its proposals.
- 5d95ad2: A store answers shopping agents out of the box: a UCP 2026-08-25 profile at `/.well-known/ucp`, its catalogue search and checkout tools at `POST /api/ucp/mcp`, and a `continue_url` that hands the agent's cart to your checkout page.
  The API also serves `/robots.txt` (named AI crawlers allowed, shopper and admin paths kept out), `/llms.txt` and `/agents/products.json`.
  Set `agents.ucp.links` to your privacy and terms pages; `agents.ucp.enabled` and `agents.crawl` (`robots`, `llms`, `feed`, `allow`, `others`) turn each part off or change it.
- 5240c52: The API's routes are MCP tools for agents, at `POST /api/mcp` (bearer, no cookie) and through `nymbal mcp`, a stdio bridge an MCP host launches (`NYMBAL_MCP_URL`, `NYMBAL_MCP_TOKEN` or `NYMBAL_MCP_EMAIL`/`NYMBAL_MCP_PASSWORD`).
  A tool that runs a command only proposes it until you set `agents: { mcp: { writes: 'apply' } }`; `agents.mcp.enabled: false` turns the endpoint off.
  `@nymbalhq/http` now depends on the MCP TypeScript SDK, which brings Zod 4.
- d441055: `AiAdapter.chat(messages, { system, maxTokens })` on Anthropic and the new `@nymbalhq/ai-openai` (`config: { model, baseUrl? }`, any OpenAI-compatible server).
  A custom ai adapter must now add `chat()`; `nymbal test:contracts --package` certifies it.
  Each call makes one attempt within `timeoutMs` (60 s by default) and throws an `AdapterError` that never carries the key.
- 061bc68: `chat()` takes `tools` and a `signal` and answers `toolCalls`, and `chatStream()` streams the answer, on Anthropic and OpenAI. A custom ai adapter's `chat()` must now return `toolCalls` (`[]` when none).
  `@nymbalhq/ai-openai` sends `max_completion_tokens` to api.openai.com and `max_tokens` to any other host; `tokenField` in its config overrides it.
  Anthropic requests no longer go through `@anthropic-ai/sdk`, so `DEBUG=true` prints neither the key nor the conversation.
- 9d42cd4: The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
  `agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
  `nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.
- 7a136c9: `CartItem.productSlug`, `CART_LINE_MAX_QTY` and `CartLimitError` (`cart.qty_limit`).
- 2be0e86: `nymbal import --gdpr` keeps no buyer's name, email, phone, street, postcode or note on imported orders, and no import emails your customers. Imported orders keep their variant, line tax, fees and partial refunds, in the order currency's own minor units.
  A stopped import run again holds each order once and its progress ends at n/n; `--entities orders` after `--entities products` imports the orders. `customer.created.v1` gains `origin: 'import'`.
- 2fbb296: `nymbal import --rollback` removes every record your imports created (customers that already had an account stay) and refuses once the store has orders or reviews of its own; `--yes` skips the question. Media files are kept.
  The import's state file is saved atomically with a journal beside it, so a stopped import or rollback loses nothing, and an unreadable state file stops `nymbal import` instead of starting again. `--fresh` keeps what earlier runs created.
  New: `order.deleted.v1`, and `services.importRemoval`.
- c9fe50b: Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
  With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
- c52ac10: Failed logins for an email from other addresses no longer lock its owner out (each address still is); checkouts behind one address count per cart, up to 300 a minute per address; no-JS order and alert requests sent through `nymbal start` count against the shopper, except across several API processes, where they share the storefront's.
  `create-nymbal-app` asks for the admin email (`--admin-email` with `--yes`) and otherwise draws a random one.
- 13a6b2d: Product listings, search, recently viewed and `GET /api/products/:slug` serve each product's `rating` (`{ average, count }`, or null with no approved review) from the reviews adapter; the native aggregate now counts every approved review. Product cards show the stars, average and count, `nymbal-review-list` takes a `rating` for its summary, and the product page's JSON-LD carries `aggregateRating`.
  A scaffolded store copies `src/lib/seo.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js, whose JSON-LD `url` now names `/product/<slug>`).
- f2c9a19: Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
  Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
- ac55979: With the default JWT secret, `nymbal dev` listens on 127.0.0.1 only, and a custom server (`createApp` plus its own adapter) on a non-loopback host now throws `config.default_jwt_secret_exposed` outside production too: set `NYMBAL_JWT_SECRET`.
  Cookies are `Secure` exactly when the public URL (`NYMBAL_PUBLIC_URL`, else `store.url`) is https; descriptions are stored sanitised (one saved before this version is not rewritten: re-save any that came from an untrusted source); a rotated refresh token replayed after 30 s signs its customer out everywhere; a 500 no longer shows a driver's message.
  The WooCommerce importer fetches images only over http(s) from public addresses or the store's own host, and stores only image types.
- 402a5d1: Shipping an order emails the shopper once, listing the items with a link to the carrier's tracking page (USPS, UPS, FedEx, DHL, Royal Mail) and to their order.
  The order emails now greet "Hi there," when the first name is blank, and skip empty addresses and imported `.local` placeholder addresses.
- 1a5b417: Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
  `nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
  `createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.

### Patch Changes

- 12e3285: A repeat stock or price alert subscribe sends no second confirmation within 10 minutes of the last (new event `alert.confirmation_sent.v1`; migration `0020`). Alerts skip an address that unsubscribed mid-send, retention keeps dead events, and read models no longer keep a stale document when `nymbal replay` runs beside a live server.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- 07ff236: `SettingWriteResult.source` and the `settings.changed` event's `source` can be `'config'` or `'env'`: what still sets a field after its saved value is deleted.

## 1.5.0

### Minor Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- 0b51500: A subscribe for a stock or price alert that is already active is logged as `alert.repeated.v1`; nothing is sent.
- 965b85a: Email adapters can report bounces and complaints from `receiveWebhook` as `<provider>.bounced.v1` and
  `<provider>.complained.v1`; a hard bounce or a complaint stops alert mail to that address. Webhooks may be
  form-encoded or plain text. `runEmailFeedbackContract` certifies an email adapter's bounces and complaints.
- c778b26: Order links now expire (48 hours from checkout, 30 days from the email). After that the shopper enters their email,
  or asks for a new link. Signed-in shoppers go to their account's order page.

  Breaking: an order read with its key no longer returns `billingAddress`, phones or `customerId`, and `ShopperOrder`
  makes every field the confirmation page does not show optional.

- d9c8c5a: Shipping adapters can report tracking updates from `receiveWebhook` as `<provider>.tracking.v1`; a delivered update
  marks the shipped order delivered. `runShippingTrackingContract` certifies a shipping adapter's tracking updates.
  Breaking for a kernel composed by hand: `registerHandlers` takes `orders` (the order service).

### Patch Changes

- d0b44ed: Storefront client bundles are about 30 bytes smaller (the document-order collator is made on first use), and the
  web components and React wrappers build to the same bytes every time.

## 1.4.0

### Minor Changes

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- 295dab6: Back-in-stock alerts: `POST /api/alerts/subscribe` emails a confirmation, and `/api/alerts/confirm` and `/api/alerts/unsubscribe` take the token from its links. A variant whose stock rises from 0 publishes `product.restocked.v1`, and each confirmed subscriber gets one email. Adds the `alert_subscriptions` migration; subscribe is limited to 10 per IP per hour and answers 409 on a store whose email is `native`.
  `GET /api/capabilities` reports `email.delivers`.
  Breaking for a kernel composed by hand: `buildServices` now takes `email` (the email adapter), `registerHandlers` takes `alerts` (the alert service), and `registerCapabilitiesRoute` needs `adapters.email`.
- d724fd2: Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
  The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
- 6f73872: Any commerce adapter can take webhooks at `POST /api/webhooks/<providerName>` by implementing the optional `receiveWebhook(rawBody, headers)`; a delivery sent twice, even at once, is processed once. Its events must be named `<providerName>.<event>.v<n>` and listed in `producesEvents`, each payload a plain JSON object. `/api/webhooks/stripe` is unchanged.
  `runWebhookContract` certifies an adapter's `receiveWebhook`, and `webhookDeliveryProblem` from `@nymbalhq/types` gives the rule both apply, the first reason a delivery is refused or null.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- c8588b2: Storefronts that import `@nymbalhq/types` no longer ship the list of kernel event types in their client bundles.

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

## 1.2.0

- Audit and idempotency types: `AuditEntry`, `AuditActor`, `isValidIdempotencyKey` and the header names.
- `AdapterSetting`: a provider package declares the settings the admin can fill.
- `DocumentStoreAdapter.replaceCollection` is required, and `SearchAdapter.replaceAll` optional.
- **Breaking:** `Slot` includes `security`, and `ProviderPackage.sdk` is optional.

## 1.1.0

- `healthCheck()` on primitives, with `boundedHealthCheck` and `HEALTH_CHECK_TIMEOUT_MS` to implement it.
- `Recipe`, `stockLevel()` and `STOCK_LABELS`, `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS`.
- `compareDocumentValues`, `matchesSortKey` and `queryDocuments`, the order every document store follows. **Breaking:**
  values of different types rank by type, so `1` and `'1'` differ, and nulls sort last.
- Search pages by cursor with a `total`, and `FacetParams.query` is new.
- `MediaStorage` lives here, and `AdapterContext.slot` is a `Slot`.

## 1.0.0

- **Breaking:** an adapter's `capabilities` is a method, `capabilities()`.

## 0.2.0

- First release under `@nymbalhq`.
- `Order` carries captured and refunded amounts, with `paymentState()` and `refundableMinor()`.
- **Breaking:** `PaymentsAdapter` gains `cancelPaymentIntent`, `getPaymentIntent` and refund options; `Customer.roles`
  is required.
- `EventBusAdapter.replay` and `ProductSortKey`.
