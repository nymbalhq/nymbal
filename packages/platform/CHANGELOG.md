# @nymbalhq/platform

## 1.10.0

### Minor Changes

- bad1a72: Breaking: `agents.acp.apiKey` and `NYMBAL_ACP_API_KEY` are removed; list each assistant's key by name in `agents.acp.keys`, such as `[{ name: 'muse', key: env('NYMBAL_ACP_API_KEY_MUSE') }]`.
  An ACP order's source is `agent:<name>` of the key that opened it and each activity entry's actor `acp:<name>` of the key that sent it; `nymbal doctor` lists the keys by name.
- 64b219c: Breaking: an address's country must be an ISO 3166-1 two-letter code (`UK`, `United Kingdom` and `GBR` are refused; use `GB`), and a US region a state's code or name; the config refuses a non-ISO country in `store.shipFrom`, tax and shipping rates.
  The address form picks the country, and a US state, from a list.
- 35ce5da: Admin routes under `/api/admin/categories` list, create, change, reorder and delete categories; a parent must exist and cannot be the category or one of its descendants, and a delete moves its products out and its children up to its parent.
- 6e82231: The admin has a Reviews page: approve or reject submitted reviews, and change a decision from the Approved or Rejected tab.
  `GET /api/admin/reviews` takes `status` (pending by default), and moderating a review that does not exist answers 404.
- 4fdb102: The admin shows product prices and customer totals in the store's currency (`GET /api/admin/me` now answers `currency`).
- d64b5ed: A product has a brand and each variant a GTIN, set in the admin and served in the product page's JSON-LD and the agent feeds; a number that is not a GTIN is refused.
  Breaking: the product document gains a required `brand` and a `gtin` on each variant; run `nymbal replay --to catalogue` on an existing store so its documents carry them.
- 689edc3: `commerce.shipping.pricing: 'carrier'` (default `'table'`) charges what the shipping adapter rates (EasyPost with an `apiKey`): it needs `defaultWeightGrams`, `store.shipFrom`, no table rows and an adapter that declares `rates`; the cart is one parcel of variant weights (set by the WooCommerce importer or the API until the admin has a weight field), and a carrier that is down or slower than 5 s answers 503 `checkout.shipping_unavailable`.
  `POST /api/checkout/quote` has a built-in limit of 30 a minute per cart, counted as `/api/checkout`'s; raise it the same way for load tests. The shipping contract asks for a carrier and a service name that stay the same between calls.
  Breaking: `CheckoutError` gains `shipping_unavailable` (an exhaustive switch over its codes stops compiling), an order's `metadata.shipping.provider` is any provider name rather than only `native`, and the ACP surface's deps take `shippingPricing`.
- 452299f: `agents.roles.content`: a weekly night-shift review that proposes product SEO titles and descriptions for the Inbox, checked against copy rules and the product's own facts; `nymbal eval content` scores it.
  Product pages use a product's `seoTitle` and `seoDescription` for the `<title>` and meta description when set. Breaking: the product document and the SDK's `DenormalisedProduct` gain required `seoTitle` and `seoDescription` (run `nymbal replay`), and the demo seed leaves both blank.
- 14246b8: The dashboard's today figures follow `store.timezone` and count every paid order of the day, with refunds on the day they were made. Breaking: `GET /api/admin/dashboard` replaces `today.orderCount`, `today.revenueMinor` and `today.itemsShipped` with `paidOrders`, `units` and `money` (one row per currency, `netCapturedMinor`).
- 8b16c14: Shoppers enter discount codes on the cart page and in the checkout summary, and see the discount and the total they will be charged before the address; ACP sessions take `discounts.codes` (or `coupons`) and answer `discounts`, MCP agents get `cart_addCode` and `cart_removeCode`, and UCP checkouts total the cart's discount.
  Breaking: `CommerceAdapter.cart` methods resolve `ShopperCart` and it gains required `addCode` and `removeCode`; `CartState` gains `totals`, `promotions` and `errorCode`; the elements' `cart` projection needs `discountTotalMinor`, `totalMinor` and `codes` (the templates' `fetchCart` fills them).
  ACP sessions now carry `discounts` and `capabilities.extensions`; `POST /api/cart/codes` refuses `.` and `..`.
  A store already scaffolded copies `src/lib/api.ts` (Astro) or `lib/api.ts` (Next.js) from the new template.
- 152c3c4: Breaking: `POST /api/admin/products/:id/duplicate` now takes the first free suffix (`-copy`, `-copy-2`, …) on the slug and SKUs, so a product can be duplicated again, and the copy starts with no stock. The admin's products row menu is always shown and reports each Duplicate and Archive; the sidebar's Orders badge shows the pending count.
- 660a7a9: The admin's Inbox shows the night shift's open insights, most serious first, each with Dismiss: a dismissed subject stays quiet for 7 days. Agents read the list through `GET /api/admin/insights` and the `admin_insights_list` tool. New event `insight.dismissed.v1`.
- 8efbf8d: Amounts read with each currency's ISO 4217 minor units, from `CURRENCY_MINOR_UNITS` and `currencyExponent` in `@nymbalhq/types`: the admin shows 1999 JPY as JP¥1,999 and 1999 KWD as KWD 1.999, and its refund and price inputs take amounts in those digits.
  Breaking for HUF, IDR, COP, PKR, IQD and the other currencies where `Intl` and ISO 4217 differ: emails, the admin, the WooCommerce importer and EasyPost now read them with ISO's digits (1999 HUF reads HUF 19.99, was HUF 1,999); stored amounts do not change.
  EasyPost refuses a rate in a currency with no ISO 4217 minor units, one listed without them (such as XXX) or not listed at all (such as ZZZ), and needs `@nymbalhq/types` 1.10.0 or later.
- 924fe84: With `commerce.ai` set, the night shift's search, order and refund insights get a suggested next step from the model, shown only when every figure in it is one the store gave; `nightShift.ai.maxInsightsPerNight` caps it (5 by default, 0 turns it off). `InsightView` gains `guidance` and `guidanceWithheld`.
- b598c5c: A nightly job writes insights about stock running out, searches that found nothing, falling orders or checkout success, rising refunds and the store's own failures, configured under `nightShift: { enabled, at }` (on, from 03:00 store time, by default). Each is published as the new event `insight.created.v1`.
- 09d8bff: `nymbal heartbeat` checks once, for cron, that the store takes an order and that a saved card can be charged and refunded; turn on `features.heartbeat` and set the `heartbeat` block. A checkout with the heartbeat address is placed and cancelled without payment (`checkout.synthetic`) and kept out of the admin's lists (`?source=synthetic` lists them).
  Payments adapters gain `chargeSavedCard` behind a `saved-card` capability (native stub and Stripe); Stripe ignores the heartbeat charge's webhooks.
- da9c72b: `security.auth.legacy.remote.url` names an endpoint on your old platform that a sign-in asks, until `until`, about a shopper with no password here; set `NYMBAL_LEGACY_AUTH_SECRET` to its shared secret. The contract is in the importing guide.
- c1411ad: New `@nymbalhq/promotions-talon-one`: `commerce.promotions: { provider: 'talon-one', config: { baseUrl, apiKey, currency } }` lets Talon.One decide every code and code-less campaign, priced under the store's totals rule.
  A paid order closes its promotions engine session and a cancelled order cancels it, once, for an engine that supports it, so Talon.One counts a code's use and gives it back.
- 84cecf1: A refund can name the order line it is for (`variantId` on `POST /api/admin/orders/:id/refund` and on each refund, with its `productId`), and the nightly refund insight names the product whose refunds rose.
- 3e72f2b: `nymbal replay --to reports` rebuilds report figures from the event log for the days it still holds whole (`--dry-run` counts what would change); run it after upgrading or to repair reports, with the server stopped or idle on SQLite.
- 322a42e: `GET /api/admin/reports` money totals now include today so far, marked `partial`; rates, funnel and top products still count closed days.
- ce6de60: The profile page lists the devices a shopper is signed in on (`nymbal-session-list`, `SessionList`), and each can be signed out, or every one at once; signing out now ends only that browser's session, and the release signs nobody out.
  Breaking: a custom `CommerceAdapter` must implement `customers.listSessions`, `endSession` and `endAllSessions`.
- c17ff1c: Staff and system notes on an order are stored apart from the shopper's checkout note (new column `orders.staff_notes`; run migrations), so a checkout note is always shown word for word as the customer's. An order noted before this release shows its old note list as the shopper's note.
- 7e965d7: `nymbal suppressions show <email>` says whether an address is suppressed, why and since when; `nymbal suppressions list [--limit n]` lists suppressed addresses, newest first. `EmailSuppressionRepository.list` backs it.
- f7edde7: A tax provider that declares `commit` and `refund` now has paid orders and their refunds filed with it in the background, retried every 5 minutes, and `nymbal doctor` shows a `tax documents` line.

### Patch Changes

- 8112f97: Admin search now finds any product by part of its name or slug, not only among the oldest 200; the admin products list's `q` matches the slug too.
- 5f9281b: Admin search now finds any order and any customer, not only recent orders and the customers who placed them, and an order whose number is the term comes first; on SQLite the admin orders list's `q` and `customer` filters now fold case in any script, not ASCII alone.
- d92618d: Reading a cart re-checks its discount codes, so a code deactivated or expired since it was applied shows as refused at full price, as the checkout charges.
- 7e6ec0c: A record's history names each change's own actor and command, so a payment an admin or a provider records after checkout no longer reads as the shopper's checkout; entries recorded before this release are unchanged (new column `events.command_id`; run migrations).
- f5bfc9a: A provider package can declare a secret optional when another setting is set (`optionalWith` on a `settings` entry).
  `@nymbalhq/ai-openai` works with Ollama, vLLM and other keyless OpenAI-compatible servers at a `baseUrl` without a dummy `apiKey`, and sends no `Authorization` header when it has no key.
  A keyless host needs this release of `@nymbalhq/platform` too; with an older kernel the slot stays not configured.
- e0f3f5d: A product viewed in the same millisecond as sign-in now lands on the same recently-viewed list live and after a rebuild.
- 151fb67: Settings secrets inside a `Map` or `Set` are now scrubbed from logs and error responses, as they already were inside plain objects, arrays and errors.
- 1193705: A Settings secret containing `*` can no longer be rebuilt in logs and error responses by the `***` mask and the text beside it.
- 797f011: On Postgres, a refund whose tax filing failed while another filing of the same order was finishing stays due, so the sweeper retries it.
- Updated dependencies [bad1a72]
- Updated dependencies [64b219c]
- Updated dependencies [ebf8ea0]
- Updated dependencies [6e82231]
- Updated dependencies [d64b5ed]
- Updated dependencies [689edc3]
- Updated dependencies [452299f]
- Updated dependencies [14246b8]
- Updated dependencies [8b16c14]
- Updated dependencies [7e6ec0c]
- Updated dependencies [660a7a9]
- Updated dependencies [f5bfc9a]
- Updated dependencies [8efbf8d]
- Updated dependencies [924fe84]
- Updated dependencies [b598c5c]
- Updated dependencies [09d8bff]
- Updated dependencies [aec9558]
- Updated dependencies [da9c72b]
- Updated dependencies [c1411ad]
- Updated dependencies [84cecf1]
- Updated dependencies [ce6de60]
  - @nymbalhq/config@1.10.0
  - @nymbalhq/types@1.10.0

## 1.9.0

### Minor Changes

- b4134f0: `nymbal events retry` lists dead events and puts them back for the running store to deliver, 100 a run; events older than `events.retentionDays` stay dead, and `nymbal doctor` names the command. Back-in-stock and price-drop alerts now re-read the variant, so a late event no longer mails a stale claim.
- 86aed8e: Breaking: a command now answers once its events reach the `derived` subscriptions (projections, search, report rollups); mail, webhooks and a store's own subscriptions run after the answer, so a slow mail provider no longer slows requests or shows which addresses have accounts. A derived handler runs at the commit and again on delivery, so it must be idempotent; call `relay.drain()` to wait for every subscription.
- 6822798: Shoppers can reset a forgotten password by email (`/account/forgot-password`) and change it on `/account/profile`, which signs out every other session; one account's failed sign-ins are refused past ten times the login limit until a reset.
  Breaking: `security.auth.accessTtl` must be 1m to 1h and `refreshTtl` longer than it, or the store refuses to start, naming the field.
  Per-address rate limits now count an IPv6 client by its /64, where before each full address was its own bucket.
- b74f305: Discount codes: a `promotions` commerce slot with a native engine, `POST /api/cart/codes` and admin routes under `/api/admin/promotions`.
  Cart, order and charge now come from one totals function; `POST /api/checkout` accepts `expectedTotalMinor` and refuses any other total.
- c9bb448: Breaking for a third-party payments adapter: `PaymentsAdapter` gains a required `listRefunds(paymentId)` (oldest first), and `refund` must record its `idempotencyKey` where the list returns it.
  A refund made in the provider's dashboard now appears on the order, and a refund left pending by a lost answer settles from the provider's list within minutes. Stripe endpoints also subscribe to `charge.refunded`.
- 6339654: A store that confirms sign-ups by email removes an account never confirmed 30 days after its last sign-up attempt, unless it has an order. A shopper who never confirmed and comes back after that registers again.
- d29f7e1: Breaking: a refund no longer changes an order's `status`, which now only says where the goods are. `OrderStatus` loses `refunded` and `partially_refunded` on every read, `statusBeforePartialRefund` and `orderMovesFrom` are gone, `?status=refunded` and `?status=partially_refunded` answer 400, and stored orders migrate on boot; event types and payloads are unchanged.
  Read a refund from `payment.state`, now on shopper order answers, and filter with `?payment=unpaid|paid|partially_refunded|refunded`. A fully refunded unshipped order stays in `?status=confirmed`, and `?payment=` separates it; fulfilling it answers 409 `order.refunded`, while a shipped one may still be delivered. `@nymbalhq/types` adds `fulfilmentMoves` and `canRefund`.
  WooCommerce `refunded` orders import as `confirmed`.
- 6ce7da1: Breaking: on a store with an email provider, `POST /api/auth/register` answers 202 "check your email" for every address and signs nobody in until the mailed link (`/account/verify-email`) is followed; `security.auth.verification: 'off'` keeps the old behaviour, and a `native` store is `off` by default.
  Support can send the link again or mark the email confirmed from the customer's admin page; `nymbal doctor` and the admin dashboard warn when sign-ups are not confirmed or mail may not be arriving.
  Until an address is confirmed, a later register for it replaces the waiting account's password; its owner can still set their own with Forgot password.
  A store scaffolded before this release needs the template's `/account/verify-email` page before it adds an email provider, or the mailed link lands on a missing page.
- f7ad028: `commerce.shipping.rates` sets flat delivery options per country (optional `freeOverMinor`); `POST /api/checkout/quote` (MCP `checkout_quote`) prices the cart with shipping and tax, the checkout element and ACP show it and send `shippingOptionId` and `expectedTotalMinor`, and a checkout charging shipping or tax on top with no `expectedTotalMinor` is refused.
  Tax rows gain `taxShipping` (default `true`): a store that zero-rates goods through `codes` still taxes delivery at the row's percent unless the row sets `taxShipping: false`.
  Breaking: the SDK drops `setShippingMethod` and `ShippingMethod`; use `quote()` and `selectShippingOption(id)` (`useCheckout()`: `requestQuote` and `selectShippingOption`), and the state's `quote` and `quoting`.
- 5a71306: An approved proposal whose server stopped before it finished now settles after 15 minutes without running again: Applied when the store shows it ran, Failed when it shows it did not, and a new Outcome unknown badge when it cannot tell, as for a refund.
- 2c34f0d: `nymbal suppressions clear <email>` takes an address off the email suppression list.
- 4ad006f: Checkout charges tax from `commerce.tax.rates` (a row per country or US state, optional per-code rates; `onUnavailable: 'refuse' | 'native'`), and `store.pricesIncludeTax: true` extracts it from prices, shown as "Tax (included)"; a store with no rates is unchanged.
  Tax added on top of prices is charged only when `POST /api/checkout` sends the taxed total as `expectedTotalMinor`; the checkout element and agent checkouts do not send it yet, so they are refused on such a store.
  Breaking for a `custom` tax adapter: `calculate` is replaced by `capabilities()` and `quote()` (optional `commit` and `refund`); run `runTaxContract` from `@nymbalhq/contract-tests` against it.
- 4097e20: `dist/kit.js` puts a cart on a WordPress theme with one script tag and two meta tags, and a set-up that cannot work says why in the console. `POST /api/alerts/subscribe` accepts `linkOrigin`, held to `http.cors.allowedOrigins` and the new `http.cors.kitOrigins` (a site listed there gets CORS on the cart's routes alone), and `createNymbalClient` an `alertLinkOrigin`, so alert links reach the store.
- 749d08d: `nymbal import --source woocommerce --password-hashes <file>` loads WordPress password hashes (`wp db query "SELECT user_email, user_pass FROM wp_users" --skip-column-names`) for imported customers, who then sign in with their WordPress password once and hold a Nymbal one. Set `security.auth.legacy.until` (a date at most 366 days ahead) first: after it, old hashes are refused and swept. `security.auth.legacy.maxCost: 11 | 12` accepts the costlier bcrypt WordPress writes on PHP 8.4, at the price of slower refused sign-ins until that date.

### Patch Changes

- 5118a9c: The admin shows order status changes, product edits and stock moves made elsewhere without a reload, and keeps an unsaved product edit when a new copy arrives. A refused stock adjustment shows the store's reason instead of Done.
- 2c34f0d: The admin products search finds any product by name; a tracking number the carrier refuses leaves a note on the order; the assistant masks customer details in history changes; a price-drop email quotes the last price the subscriber was told.
- ba1f2b3: `nymbal eval assistant --stamp` records the run's tokens, and a change of the default model now needs a new stamp.
- e78beeb: A refresh still in flight for a token that a sign-out or a sign-out-everywhere just ended now gets a 401 instead of a new session.
- Updated dependencies [86aed8e]
- Updated dependencies [6822798]
- Updated dependencies [b74f305]
- Updated dependencies [c9bb448]
- Updated dependencies [d29f7e1]
- Updated dependencies [6ce7da1]
- Updated dependencies [f7ad028]
- Updated dependencies [5a71306]
- Updated dependencies [4ad006f]
- Updated dependencies [4097e20]
- Updated dependencies [749d08d]
  - @nymbalhq/types@1.9.0
  - @nymbalhq/config@1.9.0

## 1.8.0

### Minor Changes

- 04e0cfe: Admin MCP tool results no longer carry customers' emails, phones, street lines or postcodes; `agents.mcp.withhold` lists what is withheld and each result names it in `withheld`. Breaking for admin MCP clients that read those fields: set `agents.mcp.withhold: []` to send them.
- 5b51750: Anthropic requests cache the tool definitions and system prompt for later conversations too, so a new assistant conversation reads them from the cache instead of paying to write them again.
  Chat `usage` adds `cacheReadTokens` and `cacheWriteTokens` where the provider reports them (OpenAI: cached prompt tokens), and `nymbal eval assistant` prints token usage per run and in total, also in `--json`.
- 06e65ca: Ask makes at most three deletions, archives, cancellations or refunds per message and refuses bulk ones, and is no longer offered the store's settings; a route marks these with `destructive: true` and `agents: { assistant: false }`.
  A `runAssistantTurn` answer cut at the model's length limit now ends with an `error` frame `assistant.answer_cut` instead of `done`.
- 71283b7: `nymbal eval assistant --stamp <file>` records a passing run against Anthropic's or OpenAI's own API: the hash of the assistant's prompt and tools, the provider, the model and the tally. `--json` now includes that hash, and each run's report lists the models that answered.
- 70380e7: The admin's assistant shows a card for each order or customer it read, filled from the store, and sends order and product lists to the AI provider as summaries. `AssistantFrame` gains a `record` event.
  `GET /api/admin/orders` filters by shipping `postcode` and `country` in the store's query and answers `meta.total`; `customer`, `q` and date filters now find orders of any age. MCP tool results of a paged list are `{ items, total }` or `{ items, nextCursor }`, where they were `{ items }`.
  `nymbal eval assistant` asks 27 questions; its default threshold is 24.
- 02133c3: `nymbal eval assistant` accepts a fact in any form its record gives (an order's number, email or shipping name), any read that answers, and reads on questions that need no tool; `--runs <n>` judges each question by majority, `--verbose` prints each call, and an AI provider error on the key, balance or request exits 2. Breaking: `--json` now prints `{ runs, passed, total, threshold, questions, reports }` in place of one report.
- 3991ca5: An order refunded in part can still be processed, shipped and marked delivered (in the admin, the API or by a carrier's delivered update), moving on only from the status it was refunded at; its payment keeps reading partially refunded.
  A further partial refund no longer moves the order's status, and still shows on the order's timeline. New in `@nymbalhq/types`: `orderMovesFrom` and `statusBeforePartialRefund`.
- 67a952e: `GET /api/admin/orders`, `/api/admin/products` and `/api/admin/inventory` answer 400 `validation.failed` naming the allowed statuses for an unknown, empty or repeated `status` (and the orders list for an unreadable or repeated `dateFrom`/`dateTo`; a date-only `dateTo` now covers its whole UTC day), where they answered 200. Pending reviews in `GET /api/admin/reviews` carry `productName` and `productSlug`.
  `GET /api/products/search` answers 400 for a missing, blank or repeated `q`, so `client.products.search('')` now rejects with `validation.failed`: a store's own search box should skip an empty input.

### Patch Changes

- ec032f4: The assistant reads each listed order's revenue (captured less refunded) and each listed product's type and variant options.
  The assistant knows today's date in the store's time zone.
- Updated dependencies [04e0cfe]
- Updated dependencies [5b51750]
- Updated dependencies [70380e7]
- Updated dependencies [3991ca5]
- Updated dependencies [ec032f4]
  - @nymbalhq/config@1.8.0
  - @nymbalhq/types@1.8.0

## 1.7.0

### Minor Changes

- 071e340: The admin's assistant sends a customer's email, phone, street lines and postcode to the AI provider as placeholders (`[email-1]`) and shows you the real values; choose the fields in `agents.assistant.mask` (`[]` turns it off). `nymbal doctor` names the AI host and what it receives.

### Patch Changes

- Updated dependencies [071e340]
  - @nymbalhq/config@1.7.0
  - @nymbalhq/types@1.7.0

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
- 9d42cd4: The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
  `agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
  `nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.
- 7a136c9: A guest's cart joins the customer's at sign-in (quantities summed, at most 99 a line), logout ends the cart cookie, and the cart refuses a line above 99, an unknown body key and a variant not for sale. `createCartService` now takes `catalogue: createCartCatalogue(repos)`.
- a4a8db6: The API runs on Fastify 5, drizzle-orm 0.45 and Zod 4. `FastifyHttpAdapter.registerPlugin` takes a Fastify 5 plugin, and `@nymbalhq/config` exports Zod 4 schemas.
  A DELETE sent with `Content-Type: application/json` and no body now answers 400.
- 2fbb296: `nymbal import --rollback` removes every record your imports created (customers that already had an account stay) and refuses once the store has orders or reviews of its own; `--yes` skips the question. Media files are kept.
  The import's state file is saved atomically with a journal beside it, so a stopped import or rollback loses nothing, and an unreadable state file stops `nymbal import` instead of starting again. `--fresh` keeps what earlier runs created.
  New: `order.deleted.v1`, and `services.importRemoval`.
- c9fe50b: Set `NYMBAL_ORIGIN_SECRET` and the API answers only requests that carry it in `X-Nymbal-Origin`, so traffic must cross your CDN (`/health`, `/ready` and the same machine excepted).
  With Cloudflare, `nymbal security:apply` creates it, adds the header at the edge and reads `CF-Connecting-IP`; add Zone › Transform Rules › Edit to an existing token, as every `security:*` command now reads that phase.
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
- 07ff236: Gated routes answer 401 or 403 before they read the request; an admin event-stream ticket opens one stream however many opens race it; an admin can delete a saved setting the config or environment overrides.
- 040f754: `GET /api/admin/customers` lists every customer, ordered or not; a customer's Lifetime Value and Avg Order count money kept after refunds, over all their orders.
- 366760e: `nymbal doctor` reports native search and reviews as not checked when the command store is down, instead of ok.
- 2be0e86: `nymbal import --gdpr` keeps no buyer's name, email, phone, street, postcode or note on imported orders, and no import emails your customers. Imported orders keep their variant, line tax, fees and partial refunds, in the order currency's own minor units.
  A stopped import run again holds each order once and its progress ends at n/n; `--entities orders` after `--entities products` imports the orders. `customer.created.v1` gains `origin: 'import'`.
- 454e12a: An admin cancel gives a pending order's stock back at once. `POST /api/checkout` answers 401 `auth.token_invalid` for an access token it cannot verify, so the client refreshes and places the order as the customer. The `payment.failed` reason for a wrong amount is now just `amount_mismatch`; the order's history note shows both amounts as money.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- 41ef49d: Expired and used refresh tokens are now deleted on a schedule, so the table holds about one row per signed-in session.
  A signed refresh token whose row is gone (for example after restoring an older database backup) now ends that customer's sessions instead of only being refused.
- 2778182: The storefront serves only active products and their active variants, two admin price edits of one variant at once log a true price history, and `GET /api/categories` returns every category. A store on a package search adapter (Algolia) runs `nymbal replay --to search` after upgrading to drop drafts from its index.
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
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.
- 0b51500: A subscribe for a stock or price alert that is already active is logged as `alert.repeated.v1`; nothing is sent.
- bb453b8: New `algolia` search provider (`@nymbalhq/search-algolia`, `nymbal add algolia`), matching as native search does. Fill
  it once with `nymbal replay --to search`. A restart no longer rebuilds a search index that lives in a package.
- 5db4e1b: `nymbal build --image` builds your store into one container image; `nymbal start` runs it in production on one port
  (`PORT`, with `NYMBAL_PUBLIC_URL` set), answers `/ready` and drains on SIGTERM; `nymbal deploy fly|railway --dry-run`
  writes `fly.toml` or `railway.json` and prints the deploy steps. New Astro stores read `NYMBAL_API_URL` at run time.
- 39c852e: Commands print slots in kebab case (`document-store`, `event-bus`): doctor's checks, `nymbal dev` and `config:validate`; `test:contracts --slot` accepts either spelling.
  Breaking: a script reading `nymbal doctor --json` matches `primitive document-store` and `primitive event-bus` (and the same for `package`) now, in place of the camelCase names; `config:validate`'s summary says `command store:` in place of `commandStore:`.
- 59e1639: New `easypost` shipping provider (`@nymbalhq/shipping-easypost`): set `shipping.provider: 'easypost'`, and its tracker
  webhooks (`/api/webhooks/easypost`) mark a shipped order delivered.
- 965b85a: Email adapters can report bounces and complaints from `receiveWebhook` as `<provider>.bounced.v1` and
  `<provider>.complained.v1`; a hard bounce or a complaint stops alert mail to that address. Webhooks may be
  form-encoded or plain text. `runEmailFeedbackContract` certifies an email adapter's bounces and complaints.
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

- 0b51500: A delivery that fails while the event bus, document store or a commerce adapter reports itself down no longer uses
  up the event's retries: it is tried again at a steady pace and sent once the adapter is back. Each such pass logs one
  `outage:` warning naming what is down.
- a67f867: New `resend` email provider (`@nymbalhq/email-resend`): it sends over Resend's SMTP relay, and its bounce and
  complaint webhooks stop alert mail to bad addresses. Set Resend's webhook URL to `/api/webhooks/resend`.
- ab6c631: New `ses` email provider (`@nymbalhq/email-ses`): it sends over Amazon SES SMTP, and its SNS bounce and complaint
  notifications stop alert mail to bad addresses. Subscribe the SNS topic to `/api/webhooks/ses` over HTTPS.
- d9c8c5a: Shipping adapters can report tracking updates from `receiveWebhook` as `<provider>.tracking.v1`; a delivered update
  marks the shipped order delivered. `runShippingTrackingContract` certifies a shipping adapter's tracking updates.
  Breaking for a kernel composed by hand: `registerHandlers` takes `orders` (the order service).

### Patch Changes

- eed87ad: Concurrent first checkouts on a new Postgres store no longer fail with a duplicate key error on the order number.
- 733d4b1: A store whose adapter loads its own copy of `@nymbalhq/types` now fails to start, naming both copies, instead of
  mishandling that adapter's errors.
- 86724f2: `nymbal replay` no longer hides products and other changes made while it rebuilds: each read model is caught up before it is swapped in.
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

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- 295dab6: Back-in-stock alerts: `POST /api/alerts/subscribe` emails a confirmation, and `/api/alerts/confirm` and `/api/alerts/unsubscribe` take the token from its links. A variant whose stock rises from 0 publishes `product.restocked.v1`, and each confirmed subscriber gets one email. Adds the `alert_subscriptions` migration; subscribe is limited to 10 per IP per hour and answers 409 on a store whose email is `native`.
  `GET /api/capabilities` reports `email.delivers`.
  Breaking for a kernel composed by hand: `buildServices` now takes `email` (the email adapter), `registerHandlers` takes `alerts` (the alert service), and `registerCapabilitiesRoute` needs `adapters.email`.
- d724fd2: Breaking in effect for your own handlers: a named handler that throws is now retried, up to five times over about 2.5 minutes, before its event is dead, so make it idempotent (for example with `withIdempotency`). `createApp` takes `relay` options for the attempts and the delay.
  Migration `0015` adds `events.retry_at`. `nymbal doctor` lists dead events, and `nymbal events query --json` prints `attempts` and `deadAt`.
- d724fd2: Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
  The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
- 63ede12: An order page and `GET /api/orders/:orderNumber` now need the order's key (checkout answers `orderKey`, sent as the `x-nymbal-order-key` header; the page is `/order/<n>?key=<key>`) or the owner's session; anyone else gets 404. Set `store.url` so the order email links to the order. Run `nymbal migrate`.
  Breaking: a store scaffolded from an older template takes four files from the new one, or its confirmation page shows "not found". Astro: `src/pages/checkout.astro`, `src/pages/order/[orderNumber].astro`, `src/scripts/order-status.ts`, `src/lib/api.ts`. Next: `app/(shopper)/checkout/CheckoutView.tsx`, `app/(shopper)/order/[orderNumber]/page.tsx`, `components/client/OrderStatusRefresh.tsx`, `lib/api.ts`.
- 6f73872: Any commerce adapter can take webhooks at `POST /api/webhooks/<providerName>` by implementing the optional `receiveWebhook(rawBody, headers)`; a delivery sent twice, even at once, is processed once. Its events must be named `<providerName>.<event>.v<n>` and listed in `producesEvents`, each payload a plain JSON object. `/api/webhooks/stripe` is unchanged.
  `runWebhookContract` certifies an adapter's `receiveWebhook`, and `webhookDeliveryProblem` from `@nymbalhq/types` gives the rule both apply, the first reason a delivery is refused or null.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.
- d546cd3: Breaking: `createNativeAiAdapter` is removed; it threw on every call. Set `ai: { provider: 'none' }` or `'anthropic'` in its place.
  `runAiContract` and the `ai` kind of `nymbal test:contracts` are removed; test a custom AI adapter with your own suite.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- d546cd3: The refresh cookie's Max-Age follows `security.auth.refreshTtl`, so it no longer outlives the token it carries.
- ea1926d: `GET /api/orders` and `GET /api/orders/:orderNumber` no longer return an order's internal fields: `metadata` is `{}`, `notes` is `''` and `paymentIntentId` is `null`. The admin order routes still return them.
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

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 1.2.0

- Every write leaves an audit entry, and admin writes accept an `Idempotency-Key` that applies them once. See
  `/admin/activity` and `nymbal audit export`.
- Every event carries its operation's correlation id (`x-correlation-id`); `nymbal events query|tail` read the log, and
  `events.retentionDays` with an optional private S3 archive manage old events.
- `nymbal replay --to <model>` rebuilds a read model from the tables, and boot rebuilds every read model. A custom
  document store must implement `replaceCollection`.
- Provider keys can be saved in the admin's Settings, encrypted under `NYMBAL_SECRETS_KEY`. Back the key up: a store
  holding saved secrets does not start without it. Run `nymbal migrate`.
- `security.adapter: 'cloudflare'`, third-party adapters certified with `nymbal test:contracts --package`, and Node 26.
  **Breaking:** `'aws-waf'` and `'akamai'` now fail at start; use `middleware` or `cloudflare`.

## 1.1.0

- `nymbal dev` starts quietly, and `nymbal doctor` checks a project without changing it; primitives may implement
  `healthCheck()`.
- Native full-text search in the store's own database, with cursor pages, totals and category facets. Run
  `nymbal migrate`. **Breaking:** a query matches word prefixes, not substrings.
- `nymbal add redis|postgres|s3|stripe`, and Redis or Postgres JSONB read models, a Redis Streams bus and S3 media, each
  in its own package.
- Storefronts render from `GET /api/capabilities`. **Breaking:** templates no longer read Stripe variables; give the API
  `STRIPE_PUBLISHABLE_KEY` (or `payments.config.publishableKey`).
- **Breaking:** delete `infrastructure.cloud` and `infrastructure.compute`; code that calls `createPlatform` passes the
  primitives from `resolvePrimitives(config)`; `<nymbal-variant-selector>` takes `VariantOption[]` only.

## 1.0.0

- Provider SDKs live in `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and `@nymbalhq/adapter-smtp`: install
  the one your config names.
- **Breaking:** unknown providers fail `loadConfig`. Use `ai: { provider: 'none' }` for no AI and
  `email: { provider: 'smtp' }` for SMTP mail.
- **Breaking:** an adapter's `capabilities` is a method, `capabilities()`.
- `createApp(config, { adapters })` puts your own adapter in a `custom` slot.

## 0.2.0

- First release under `@nymbalhq`.
- Real transactions, durable events, persistent carts and a checkout that completes; concurrent checkouts no longer
  oversell.
- Orders record captured and refunded money, and refunds go through the payments adapter by amount. **Breaking:**
  `partial-refund` is gone, and a `PaymentsAdapter` must implement `cancelPaymentIntent` and `getPaymentIntent`.
- CSRF on every write, login rate limits, roles in a `customers.roles` column and a schema on every route. **Breaking:**
  `http.trustProxy` defaults to `false`; set it to `true` behind a proxy.
- Sorting with `?sort=`, verified Stripe webhooks, and a production store that refuses the stub payments adapter and the
  default JWT secret.
