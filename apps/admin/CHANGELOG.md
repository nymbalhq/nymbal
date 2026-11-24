# @nymbalhq/admin

## 1.10.0

### Minor Changes

- ebf8ea0: Report response types for `GET /api/admin/reports` are exported. The admin has a Reports page.
- 6e82231: The admin has a Reviews page: approve or reject submitted reviews, and change a decision from the Approved or Rejected tab.
  `GET /api/admin/reviews` takes `status` (pending by default), and moderating a review that does not exist answers 404.
- d64b5ed: A product has a brand and each variant a GTIN, set in the admin and served in the product page's JSON-LD and the agent feeds; a number that is not a GTIN is refused.
  Breaking: the product document gains a required `brand` and a `gtin` on each variant; run `nymbal replay --to catalogue` on an existing store so its documents carry them.
- 452299f: `agents.roles.content`: a weekly night-shift review that proposes product SEO titles and descriptions for the Inbox, checked against copy rules and the product's own facts; `nymbal eval content` scores it.
  Product pages use a product's `seoTitle` and `seoDescription` for the `<title>` and meta description when set. Breaking: the product document and the SDK's `DenormalisedProduct` gain required `seoTitle` and `seoDescription` (run `nymbal replay`), and the demo seed leaves both blank.
- 14246b8: The dashboard's today figures follow `store.timezone` and count every paid order of the day, with refunds on the day they were made. Breaking: `GET /api/admin/dashboard` replaces `today.orderCount`, `today.revenueMinor` and `today.itemsShipped` with `paidOrders`, `units` and `money` (one row per currency, `netCapturedMinor`).
- 660a7a9: The admin's Inbox shows the night shift's open insights, most serious first, each with Dismiss: a dismissed subject stays quiet for 7 days. Agents read the list through `GET /api/admin/insights` and the `admin_insights_list` tool. New event `insight.dismissed.v1`.
- 8efbf8d: Amounts read with each currency's ISO 4217 minor units, from `CURRENCY_MINOR_UNITS` and `currencyExponent` in `@nymbalhq/types`: the admin shows 1999 JPY as JP¥1,999 and 1999 KWD as KWD 1.999, and its refund and price inputs take amounts in those digits.
  Breaking for HUF, IDR, COP, PKR, IQD and the other currencies where `Intl` and ISO 4217 differ: emails, the admin, the WooCommerce importer and EasyPost now read them with ISO's digits (1999 HUF reads HUF 19.99, was HUF 1,999); stored amounts do not change.
  EasyPost refuses a rate in a currency with no ISO 4217 minor units, one listed without them (such as XXX) or not listed at all (such as ZZZ), and needs `@nymbalhq/types` 1.10.0 or later.
- 84cecf1: A refund can name the order line it is for (`variantId` on `POST /api/admin/orders/:id/refund` and on each refund, with its `productId`), and the nightly refund insight names the product whose refunds rose.

### Patch Changes

- 8d445ae: The admin works from the keyboard: `g` then a letter goes to a page, `/` searches the list, `j`/`k` walk the orders, products and customers rows, Enter opens one, `x` selects an order, and `?` lists every shortcut. No shortcut fires while you type in a field.
- 66d24a2: Cmd-K goes to any admin page, shows products and customers found by name, and on an order's page lists what that order can take now (record payment, mark processing, ship, deliver, refund, cancel with a confirmation, resend the confirmation).
- 4fdb102: The admin shows product prices and customer totals in the store's currency (`GET /api/admin/me` now answers `currency`).
- ee2ef8c: The product page asks "Leave without saving?" before any link, shortcut, search pick or back button leaves unsaved changes, and the browser asks before a reload or tab close. Signing out is never held.
- 152c3c4: Breaking: `POST /api/admin/products/:id/duplicate` now takes the first free suffix (`-copy`, `-copy-2`, …) on the slug and SKUs, so a product can be duplicated again, and the copy starts with no stock. The admin's products row menu is always shown and reports each Duplicate and Archive; the sidebar's Orders badge shows the pending count.
- a86e406: The Cmd-K palette reopens empty after a command, even when it is reopened before the page has rendered again.
- 91b13f2: New Astro stores start on `astro` 7.4.7 and `@astrojs/node` 11.1.12 or later, which fix a file read through the `/_image` endpoint and an XSS through dynamic tag names.
  The admin bundles `react-router-dom` 6.30.6, which fixes two open-redirect advisories.
- c17ff1c: Staff and system notes on an order are stored apart from the shopper's checkout note (new column `orders.staff_notes`; run migrations), so a checkout note is always shown word for word as the customer's. An order noted before this release shows its old note list as the shopper's note.

## 1.9.0

### Minor Changes

- d2841a2: The orders list's bulk actions now work: Mark processing and Cancel orders show what will change, act only on the selected rows in view and report any refusals. The row menu's Cancel order works too; the unused Filter button is gone.
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
- 4ad006f: Checkout charges tax from `commerce.tax.rates` (a row per country or US state, optional per-code rates; `onUnavailable: 'refuse' | 'native'`), and `store.pricesIncludeTax: true` extracts it from prices, shown as "Tax (included)"; a store with no rates is unchanged.
  Tax added on top of prices is charged only when `POST /api/checkout` sends the taxed total as `expectedTotalMinor`; the checkout element and agent checkouts do not send it yet, so they are refused on such a store.
  Breaking for a `custom` tax adapter: `calculate` is replaced by `capabilities()` and `quote()` (optional `commit` and `refund`); run `runTaxContract` from `@nymbalhq/contract-tests` against it.

### Patch Changes

- 5118a9c: The admin shows order status changes, product edits and stock moves made elsewhere without a reload, and keeps an unsaved product edit when a new copy arrives. A refused stock adjustment shows the store's reason instead of Done.
- 2c34f0d: The order status select follows changes made elsewhere; the dashboard's revenue uses the store's currency.
- 6822798: Shoppers can reset a forgotten password by email (`/account/forgot-password`) and change it on `/account/profile`, which signs out every other session; one account's failed sign-ins are refused past ten times the login limit until a reset.
  Breaking: `security.auth.accessTtl` must be 1m to 1h and `refreshTtl` longer than it, or the store refuses to start, naming the field.
  Per-address rate limits now count an IPv6 client by its /64, where before each full address was its own bucket.
- b74f305: Discount codes: a `promotions` commerce slot with a native engine, `POST /api/cart/codes` and admin routes under `/api/admin/promotions`.
  Cart, order and charge now come from one totals function; `POST /api/checkout` accepts `expectedTotalMinor` and refuses any other total.

## 1.8.0

### Minor Changes

- 70380e7: The admin's assistant shows a card for each order or customer it read, filled from the store, and sends order and product lists to the AI provider as summaries. `AssistantFrame` gains a `record` event.
  `GET /api/admin/orders` filters by shipping `postcode` and `country` in the store's query and answers `meta.total`; `customer`, `q` and date filters now find orders of any age. MCP tool results of a paged list are `{ items, total }` or `{ items, nextCursor }`, where they were `{ items }`.
  `nymbal eval assistant` asks 27 questions; its default threshold is 24.
- 3991ca5: An order refunded in part can still be processed, shipped and marked delivered (in the admin, the API or by a carrier's delivered update), moving on only from the status it was refunded at; its payment keeps reading partially refunded.
  A further partial refund no longer moves the order's status, and still shows on the order's timeline. New in `@nymbalhq/types`: `orderMovesFrom` and `statusBeforePartialRefund`.

## 1.7.0

## 1.6.0

### Minor Changes

- 86ad196: Cmd-K in the admin has an Ask tab: the store's assistant answers from the store's own tools, and every write it wants is a proposal you approve or reject (only `agents.autoApprove` applies one at once). It needs an `ai` provider that can call tools.
  `nymbal eval assistant` asks it 20 golden questions with your key on a throwaway store and exits 0 at 17 or more.
- 00c2f07: Carts and orders record their `source`: `storefront`, `import`, or `agent:<name>` for one a shopping agent opened, kept through the buyer's sign-in. Migration `0022` adds the columns; existing rows read `storefront`.
  The admin dashboard gains an Agents tile (the last 30 days' agent orders and revenue, per agent, and the surfaces on), and an order's page names its source.
  `nymbal doctor` adds an `agents` line that warns when UCP checkout has no privacy or terms link in `agents.ucp.links`, or the public URL is plain http.
- 7cb17f1: An agent's admin write is now a proposal you approve or reject in the admin's new Inbox (`/admin/inbox`); approving runs it once, as you. Migration `0021_proposals` adds the table.
  `agents.autoApprove: ['product.update', …]` approves the commands it names at the call; a money command (`order.refund`, `order.markPaid`) cannot be listed and stops the store at boot, so only `agents.mcp.writes: 'apply'` runs those unasked.
  `admin_settings_put` is no longer an agent tool, and the client name an MCP agent sends in `_meta` is now kept on its proposals.
- 9d42cd4: The assistant's writes after it reads store data (a review, an order note, a description) always wait in the Inbox, at most ten a turn, and approval cards show the value now beside the value proposed.
  `agents.assistant.customerData: false` keeps tools that answer customer emails, phones and addresses off the assistant; the docs list them. The assistant can no longer clear a saved setting.
  `nymbal eval assistant` asks 25 golden questions, five of them injection questions, and exits 0 at 22 or more.

### Patch Changes

- 07ff236: The admin lets go of a refused session check's answer, so a non-admin sign-in no longer leaves a request open.
- 040f754: Mark Shipped asks for carrier and tracking number; a refused order action says why; the Live badge shows when the stream is down; a customer's Order History lists their orders; Recent Orders scrolls on a phone.
- 2778182: An existing product's Variants tab edits price only: SKU, name and status read as text, stock links to the variant in Inventory, and Add and Delete Variant stay on new products.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.

## 1.5.0

### Patch Changes

- 0b51500: The customer Notes panel shows saved notes, and a double-clicked note is saved once.

## 1.4.0

### Minor Changes

- 8e06b03: A variant price edited in the admin's product page now saves: `PATCH /api/admin/products/:id` takes `variants: [{ id, priceMinor, compareAtPriceMinor? }]`, ignores stock, and answers 400 `product.variant_unknown` for a variant the product does not have. Each real change publishes `product.variant_price_changed.v1` with the old and new prices and the store currency.
  Breaking for a kernel composed by hand: `createProductService` takes `currency`.
- dbf1425: The admin's Resend confirmation now sends the order email again, with a link that opens the order through a new key; a refused send is retried. The new event is `order.confirmation_resend_requested.v1`.
  `POST /api/admin/orders/:id/resend-confirmation` now answers `{ orderId, orderNumber, email }`; `sent` is gone. Pending and cancelled orders answer 409 `order.unpaid`.

### Patch Changes

- 157e040: After the API restarts or the connection drops, the admin's live lists refetch, so an order placed in the gap shows without a reload.
- 8e06b03: A long customer email wraps on the customer and order pages, so they fit a phone's width.

## 1.3.0

### Minor Changes

- 0cfbcf2: Admin History tabs on orders, products and customers: `GET /api/admin/{orders,products,customers}/:id/history`, and `?at=<instant with a zone>` on each admin detail read, back to `events.retentionDays`.
  New `GET /api/admin/products/:idOrSlug`; `customer.created` and `customer.updated` carry a `customer` snapshot. Run `nymbal migrate`.

## 1.2.0

- Activity page (`/admin/activity`): the audit trail of every write, filtered by actor, command, record or correlation
  id, with an NDJSON export. Every write sends an `Idempotency-Key`, so a double click applies once.
- Settings page: enter the provider keys the config leaves unset. Each is saved encrypted, never shown again, and
  applied when the store restarts.
- The stock-history drawer shows a variant's adjustments.

## 1.1.0

- Versioned with the other packages; no changes of its own.

## 1.0.0

- Fits a phone: below 768 px the sidebar folds behind a menu button and the pages stack.

## 0.2.0

- First release under `@nymbalhq`.
- Served by `nymbal dev` at `/admin/`; a reload keeps the merchant signed in, and orders arrive live.
- A Payment panel shows what was captured and refunded. Refunds are by amount, and an unpaid order is marked paid rather
  than confirmed.
