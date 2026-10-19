# @nymbalhq/react

## 0.2.0

### Minor Changes

- e45d84d: First release under `@nymbalhq`: the libraries publish as `@nymbalhq/*`, the CLI as `nymbal` and the scaffolder as `create-nymbal-app`.
- 26fd94a: A checkout that completes. `POST /api/checkout` now answers the payment outcome (`payment: { status: 'succeeded' |
'requires_action' | 'failed', reason? }` and `orderStatus`). When the payments adapter captures at once, as the
  `native-stub` adapter now does, the order is confirmed, its stock committed and its cart emptied in the same request;
  Stripe orders are still confirmed by the webhook. The stub takes test triggers from the receipt email: a local part
  ending `+stub-pending` stays pending, `+stub-decline` fails. One cart has at most one pending order (migration `0005`,
  `orders.cart_token` with a partial unique index): a resubmit answers the same order, a changed cart cancels the old
  intent and supersedes its order (409 `checkout.payment_in_progress` when the provider refuses), an emptied cart
  answers 409 `checkout.cart_empty` naming the order it became, and a pending order left without an intent is
  abandoned after 120 s. A capture for a cancelled order, or one that cannot confirm its order, is refunded. The
  `order-placed` email is sent once per order on `order.paid`, not on `order.placed`, so an unpaid or imported order
  sends none.

  `PaymentsAdapter` gains `cancelPaymentIntent(intentId)` and `getPaymentIntent(intentId)`, and
  `PaymentIntentParams.receiptEmail`; a third-party adapter must implement both methods. In the SDK,
  `checkout.submitPayment()` resolves to the server's result (or `null`), `paymentStatus` is `succeeded` only when the
  server says so and `requires_action` while Stripe must confirm, `checkout.markConfirmed()` is new, and the cart store
  reloads after a submit. Both templates follow `payment.status`, and their order pages show the order's real state
  ("Awaiting payment" for a pending order).

- 07d451c: Sort works. `GET /api/products?sort=` takes `newest` (the default), `price-asc`, `price-desc`, `name-asc` or `name-desc`, ties broken by slug; an unknown key, or a cursor from another sort, answers 400. Breaking in the SDK: `productList.setSort(key)` takes a `ProductSortKey` instead of `(field, direction)`, `state.sort` is that key. `load(params)` defines the listing: its `sort` and `category` become the active ones, and a `load(params)` without `sort` resets the sort to `newest`; `load()` with no arguments reloads the current sort and category, and `setSort` and `loadMore` keep them. A response that arrives after a newer request is dropped. `QueryParams.orderBy` orders a document-store query without filtering it. Both templates offer the same five sorts, keep them in `?sort=`, and render that order on the server. Category facet counts on `GET /api/products` now always count the whole catalogue.
- e29919d: Honest storefront templates.
  - **SDK.** `client.customer.addresses.{list,create,remove}` and `client.customer.orders.{list,get}` call the account
    routes that exist, with the bearer token and the envelope unwrapped.
  - **Account pages.** Both templates' account pages now use these SDK calls, so a signed-in shopper sees their
    profile, addresses and orders. An order opens by its order number.
  - **Next.js template.** Sign Out revokes the session, a reload keeps a signed-in shopper signed in, and the account
    area can add an address.
  - **Search.** Choosing a search suggestion, by click or keyboard, opens the product on both templates.
  - **Upgrades.** The templates move to Astro 7 and Next 16 with React 19.
    - `@nymbalhq/react` now targets React 19 types: its peer range is `>=19`, and the generated JSX declarations augment
      `react` rather than the global namespace. That is breaking for React 18 consumers (pre-1.0, so a minor).
    - `nymbal dev` passes `--ignore-lock` to `astro dev`, so Astro 7 stays in the foreground when an AI agent runs it.
  - **Typecheck.** The root typecheck now runs `astro check`, and the scaffold is re-synced.

### Patch Changes

- Updated dependencies [4e7e079]
- Updated dependencies [e45d84d]
- Updated dependencies [26fd94a]
- Updated dependencies [ccd3d36]
- Updated dependencies [97944c3]
- Updated dependencies [07d451c]
- Updated dependencies [e29919d]
- Updated dependencies [e90bf2d]
  - @nymbalhq/types@0.2.0
  - @nymbalhq/sdk@0.2.0
  - @nymbalhq/web-components@0.2.0
