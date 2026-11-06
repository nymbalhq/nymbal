# @nymbalhq/admin

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
