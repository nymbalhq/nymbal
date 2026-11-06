# create-nymbal-app

## 0.8.0

### Minor Changes

- ec1e87b: Breaking for new stores: both storefront templates send a content security policy (`pagePolicy` in `lib/page-policy`), which refuses framing the store, http images and any third-party script, font, pixel, browser-side call or form target (analytics, chat, Google Fonts) until you add it there. `nymbal start` adds HSTS (https only), `nosniff`, `X-Frame-Options`, a `Referrer-Policy` and a minimal policy to any page that sets none.
  The shopper's access token now stays in page memory: `client.auth.restore()` brings the session back from the refresh cookie on each page load, guests send nothing, and requests made meanwhile wait for it. A token an earlier version left in `localStorage` is removed and its shopper stays signed in.
  A client built on `@nymbalhq/sdk/core`, as the Astro template's is, calls `resumeSession(client)` from `@nymbalhq/sdk/core` once per page load before its first request; a store that keeps its own older `lib/client.ts` must add it.
- c52ac10: Failed logins for an email from other addresses no longer lock its owner out (each address still is); checkouts behind one address count per cart, up to 300 a minute per address; no-JS order and alert requests sent through `nymbal start` count against the shopper, except across several API processes, where they share the storefront's.
  `create-nymbal-app` asks for the admin email (`--admin-email` with `--yes`) and otherwise draws a random one.
- 1a5b417: Breaking: `http.trustProxy` and `NYMBAL_TRUST_PROXY_HOPS` are removed; list the proxies in front in `NYMBAL_TRUSTED_PROXIES` (default `loopback`; `uniquelocal` on Fly and Railway, which `nymbal deploy` now sets). `X-Forwarded-For` counts only from a listed proxy, and `NYMBAL_CLIENT_IP_HEADER` reads one header such as `True-Client-IP` from them.
  `nymbal deploy nginx|apache|caddy` writes a web server config for your own server.
  `createHttpServer` takes `network: app.network`; a security adapter may offer these values through `network()`.

### Patch Changes

- 0f751fe: A page the browser restores on Back reloads the mini-cart's count and unlocks a sign-in, register or Astro alert form that locked as it left. Text typed into a server-rendered form field before its element upgrades stays in the field.
- 366760e: A new store's `.env.example` no longer lists `ANTHROPIC_API_KEY`: AI is off until you add it.
- 73c9738: `nymbal preview --source woocommerce --url … --key … --secret …` imports your WooCommerce store into a throwaway store and serves it on your storefront, and writes `nymbal-preview-report.{json,md}` (counts, differences, drafts) and `nymbal-redirects.csv`; your own store is not touched. A store already scaffolded copies `src/lib/page-policy.ts` (Astro) or `lib/page-policy.mjs` (Next.js) so images load from the API's origin.

  `nymbal import`: of two products whose slugs clash, the first in WooCommerce keeps the slug.

- 1924ab1: The order page reopens an expired order link by email and sends "send me my order link" without JavaScript, and a signed-in shopper opening their own order's link lands on their account's order page. A store already scaffolded copies the order page, `src/lib/api.ts` and `src/scripts/order-access.ts` (Astro) or `app/(shopper)/order/[orderNumber]/` and `lib/api.ts` (Next.js) from the new template; the Next.js order route now sends `Referrer-Policy: strict-origin`.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- 13a6b2d: Product listings, search, recently viewed and `GET /api/products/:slug` serve each product's `rating` (`{ average, count }`, or null with no approved review) from the reviews adapter; the native aggregate now counts every approved review. Product cards show the stars, average and count, `nymbal-review-list` takes a `rating` for its summary, and the product page's JSON-LD carries `aggregateRating`.
  A scaffolded store copies `src/lib/seo.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js, whose JSON-LD `url` now names `/product/<slug>`).
- f2c9a19: Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
  Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
- 7a4c608: The Next.js search page draws no filter column when the results' facets have no values. A store already scaffolded copies the `filtered` line of `app/(catalog)/search/SearchView.tsx` from the new template.
- ac55979: A product's name or description can no longer run script on its product page, and Next.js renders the description as HTML like Astro. A store already scaffolded copies `src/lib/seo.ts`, `src/layouts/BaseLayout.astro` and `src/pages/product/[slug].astro` (Astro) or `lib/seo.ts`, `app/(catalog)/product/[slug]/page.tsx` and `app/(catalog)/home/[key]/page.tsx` (Next.js) from the new template.
  Descriptions saved before this version are not rewritten, so re-save any that came from an untrusted source before upgrading a Next.js store.
- 07ff236: Signing in follows `?redirect` only to a path on the store's own origin; anything else goes to `/account`.
  A store already scaffolded copies `lib/signed-in-target.ts` (Next.js) or `src/scripts/signed-in-redirect.ts` (Astro)
  from the new template.
- b9cd800: `/products?category=<slug>` lists that category, the empty cart shows without JavaScript, the sticky header no longer covers what is scrolled into view, and on Next.js a failed capabilities read leaves a shopper page standing (no search bar) while Try Again refetches. A store already scaffolded copies `src/lib/api.ts`, `src/pages/cart.astro`, `src/pages/products/index.astro`, `src/styles/global.css` and `src/styles/pages/pdp.css` (Astro) or `lib/{api,header,chrome}.ts`, `components/server/Header.tsx`, `app/error.tsx`, `app/globals.css`, `app/(shopper)/cart/page.tsx` and `app/(catalog)/products/page.tsx` (Next.js) from the new template.

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
