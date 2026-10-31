# create-nymbal-app

## 0.7.0

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

- 439c2aa: The storefront client can be built from `@nymbalhq/sdk/core` plus the `@nymbalhq/sdk/ns/*` namespaces a page uses; the
  Astro template does so. A store's own element that reads `client.cart`, `client.checkout` or another store namespace
  imports its `@nymbalhq/sdk/ns/<name>` module.

## 0.6.0

### Minor Changes

- 669ff51: Both templates: the confirm and unsubscribe links in alert emails now open a page whose button confirms or stops the alert, so opening a link, as a mail scanner does, changes nothing. The button works without JavaScript.
- ff6559d: Order pages show the order's timeline (placed, paid, shipped, delivered, cancelled, refunds) with the new `nymbal-order-timeline` element (`OrderTimeline` in React). `GET /api/orders/:n` serves `timeline`, and `client.customer.orders.get` returns it as `ShopperOrder`.

  `GET /api/orders` and `GET /api/orders/:orderNumber` no longer serve `history`: read `timeline` instead. The admin order routes still serve it.

- 8e06b03: Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
- 75989c8: Home and product pages show the shopper's recently viewed products with the new `nymbal-recently-viewed` element (`RecentlyViewed` in React, `client.recentlyViewed` in the SDK), kept under an HttpOnly `nymbal.visitor` cookie and moved to the customer at sign-in. `POST` and `GET /api/recently-viewed` have a built-in rate limit of 600 a minute per IP, which `security.rateLimit['/api/recently-viewed']` replaces; `nymbal replay --to recently-viewed` rebuilds the lists from the events log.
- 295dab6: Both templates show the back-in-stock form on an out-of-stock product page when the store's email delivers, and serve the `/alerts/confirm` and `/alerts/unsubscribe` pages its emails link to.

### Patch Changes

- 99fc635: Astro template: a long email on the account dashboard wraps inside its card, so the page fits a phone's width.
- d546cd3: Astro template: an unknown product, category or order answers 404 at its own URL with the not-found page, not a redirect to `/404`, and a failed product read is a 500. Next.js template: an unknown order shows one header.
- 63ede12: An order page and `GET /api/orders/:orderNumber` now need the order's key (checkout answers `orderKey`, sent as the `x-nymbal-order-key` header; the page is `/order/<n>?key=<key>`) or the owner's session; anyone else gets 404. Set `store.url` so the order email links to the order. Run `nymbal migrate`.
  Breaking: a store scaffolded from an older template takes four files from the new one, or its confirmation page shows "not found". Astro: `src/pages/checkout.astro`, `src/pages/order/[orderNumber].astro`, `src/scripts/order-status.ts`, `src/lib/api.ts`. Next: `app/(shopper)/checkout/CheckoutView.tsx`, `app/(shopper)/order/[orderNumber]/page.tsx`, `components/client/OrderStatusRefresh.tsx`, `lib/api.ts`.

## 0.5.0

- New projects render checkout, the cart page, search results, account forms, the header, footer, grids and the product
  page as Nymbal elements, rendered on the server, so pages work with JavaScript off.
- New projects own a tokens file and an elements entry where an element defined under a Nymbal tag replaces Nymbal's
  (`src/elements/index.ts` in Astro, `elements/index.ts` in Next).
- New projects get a fresh `NYMBAL_SECRETS_KEY` in `.env`. Back it up with your deploy's secrets.
- Fragment routes a CDN can cache, ISR on the Next.js catalog pages, and pages that load only the elements they render.
- New projects pin Node 26.12.1.

## 0.4.0

- The search page shows the total, loads more and filters by category.
- The product page adds the chosen quantity and variant, and the cart page steps each line.
- The storefronts render the payment step and the sort options from `GET /api/capabilities`. **Breaking:** templates no
  longer read Stripe variables; give the API `STRIPE_PUBLISHABLE_KEY`.
- The infrastructure block lists only what is built: no `cloud` or `compute`.

## 0.3.0

- A new project's config defaults ai to `none`, so it installs no provider SDK.
- Astro storefront forms submit once, however fast they are clicked.
- The Astro account pages fit a phone.

## 0.2.0

- First release under `@nymbalhq`, as `create-nymbal-app`.
- Installs by default (`--no-install` skips it), seeds through `nymbal seed`, and pins every Nymbal package to one
  version with `@nymbalhq/stack`.
- The outro prints the admin URL and credentials.
- The templates complete a checkout, sort the listing, show the shopper's account, and run on Astro 7 and Next 16.
