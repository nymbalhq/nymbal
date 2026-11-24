# @nymbalhq/importers

## 0.6.0

### Minor Changes

- 8efbf8d: Amounts read with each currency's ISO 4217 minor units, from `CURRENCY_MINOR_UNITS` and `currencyExponent` in `@nymbalhq/types`: the admin shows 1999 JPY as JP¥1,999 and 1999 KWD as KWD 1.999, and its refund and price inputs take amounts in those digits.
  Breaking for HUF, IDR, COP, PKR, IQD and the other currencies where `Intl` and ISO 4217 differ: emails, the admin, the WooCommerce importer and EasyPost now read them with ISO's digits (1999 HUF reads HUF 19.99, was HUF 1,999); stored amounts do not change.
  EasyPost refuses a rate in a currency with no ISO 4217 minor units, one listed without them (such as XXX) or not listed at all (such as ZZZ), and needs `@nymbalhq/types` 1.10.0 or later.

### Patch Changes

- 1eead46: `planWooCommerceImport` refuses a WooCommerce store in another currency, as the import does, before it reads a record.
  A delta import (`--since`) now reports a re-listed product's own warnings (unsellable, a sale, no price); lines about stock, which a delta leaves as imported, stay out. A variation whose WooCommerce price was cleared keeps its stored price in a delta, and the report says so.
- db79bd8: `nymbal import --dry-run` lists a record it cannot read under Errors, counted as refused, instead of stopping, and refuses a product whose own variations share a SKU, as the import does.
  `--concurrency` (and the `concurrency` option) must be a whole number of 1 or more; `--entities` help names all five entities and the real default.
- Updated dependencies [bad1a72]
- Updated dependencies [64b219c]
- Updated dependencies [35ce5da]
- Updated dependencies [ebf8ea0]
- Updated dependencies [6e82231]
- Updated dependencies [8112f97]
- Updated dependencies [5f9281b]
- Updated dependencies [4fdb102]
- Updated dependencies [d64b5ed]
- Updated dependencies [689edc3]
- Updated dependencies [d92618d]
- Updated dependencies [452299f]
- Updated dependencies [14246b8]
- Updated dependencies [8b16c14]
- Updated dependencies [152c3c4]
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
- Updated dependencies [e0f3f5d]
- Updated dependencies [84cecf1]
- Updated dependencies [3e72f2b]
- Updated dependencies [322a42e]
- Updated dependencies [151fb67]
- Updated dependencies [1193705]
- Updated dependencies [ce6de60]
- Updated dependencies [c17ff1c]
- Updated dependencies [7e965d7]
- Updated dependencies [f7edde7]
- Updated dependencies [797f011]
  - @nymbalhq/config@1.10.0
  - @nymbalhq/platform@1.10.0
  - @nymbalhq/types@1.10.0

## 0.5.0

### Minor Changes

- d29f7e1: Breaking: a refund no longer changes an order's `status`, which now only says where the goods are. `OrderStatus` loses `refunded` and `partially_refunded` on every read, `statusBeforePartialRefund` and `orderMovesFrom` are gone, `?status=refunded` and `?status=partially_refunded` answer 400, and stored orders migrate on boot; event types and payloads are unchanged.
  Read a refund from `payment.state`, now on shopper order answers, and filter with `?payment=unpaid|paid|partially_refunded|refunded`. A fully refunded unshipped order stays in `?status=confirmed`, and `?payment=` separates it; fulfilling it answers 409 `order.refunded`, while a shipped one may still be delivered. `@nymbalhq/types` adds `fulfilmentMoves` and `canRefund`.
  WooCommerce `refunded` orders import as `confirmed`.

### Patch Changes

- 749d08d: `nymbal import --source woocommerce --password-hashes <file>` loads WordPress password hashes (`wp db query "SELECT user_email, user_pass FROM wp_users" --skip-column-names`) for imported customers, who then sign in with their WordPress password once and hold a Nymbal one. Set `security.auth.legacy.until` (a date at most 366 days ahead) first: after it, old hashes are refused and swept. `security.auth.legacy.maxCost: 11 | 12` accepts the costlier bcrypt WordPress writes on PHP 8.4, at the price of slower refused sign-ins until that date.
- Updated dependencies [5118a9c]
- Updated dependencies [2c34f0d]
- Updated dependencies [ba1f2b3]
- Updated dependencies [b4134f0]
- Updated dependencies [86aed8e]
- Updated dependencies [6822798]
- Updated dependencies [b74f305]
- Updated dependencies [c9bb448]
- Updated dependencies [6339654]
- Updated dependencies [e78beeb]
- Updated dependencies [d29f7e1]
- Updated dependencies [6ce7da1]
- Updated dependencies [f7ad028]
- Updated dependencies [5a71306]
- Updated dependencies [2c34f0d]
- Updated dependencies [4ad006f]
- Updated dependencies [4097e20]
- Updated dependencies [749d08d]
  - @nymbalhq/platform@1.9.0
  - @nymbalhq/types@1.9.0
  - @nymbalhq/config@1.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [04e0cfe]
- Updated dependencies [5b51750]
- Updated dependencies [06e65ca]
- Updated dependencies [71283b7]
- Updated dependencies [ec032f4]
- Updated dependencies [70380e7]
- Updated dependencies [02133c3]
- Updated dependencies [3991ca5]
- Updated dependencies [ec032f4]
- Updated dependencies [67a952e]
  - @nymbalhq/config@1.8.0
  - @nymbalhq/platform@1.8.0
  - @nymbalhq/types@1.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [071e340]
  - @nymbalhq/platform@1.7.0
  - @nymbalhq/config@1.7.0
  - @nymbalhq/types@1.7.0

## 0.4.0

### Minor Changes

- 2efa507: `nymbal import` charges WooCommerce's sale prices with the regular price as compare-at, keeps counted stock (untracked items at `--untracked-stock`, default 1000), reads weights, sizes and prices in the store's own units and currency, and refuses a store in another currency. Grouped, external and price-less products arrive as drafts; tags, attributes, tax and shipping classes and public custom fields stay in `metadata.woocommerce`, also after AI enrichment.
  What could not be carried over exactly is listed under "Review before launch" in the migration report.
- a8cca3d: `nymbal import --dry-run` reads the WooCommerce store and writes `nymbal-import-plan.json` and `.md`: what the import would create, refuse and skip, slug, SKU and order-number clashes with the source or your store, the fields it never reads, a time estimate and what does not migrate. It imports nothing and opens your store read-only.
- 2be0e86: `nymbal import --gdpr` keeps no buyer's name, email, phone, street, postcode or note on imported orders, and no import emails your customers. Imported orders keep their variant, line tax, fees and partial refunds, in the order currency's own minor units.
  A stopped import run again holds each order once and its progress ends at n/n; `--entities orders` after `--entities products` imports the orders. `customer.created.v1` gains `origin: 'import'`.
- 2fbb296: `nymbal import --rollback` removes every record your imports created (customers that already had an account stay) and refuses once the store has orders or reviews of its own; `--yes` skips the question. Media files are kept.
  The import's state file is saved atomically with a journal beside it, so a stopped import or rollback loses nothing, and an unreadable state file stops `nymbal import` instead of starting again. `--fresh` keeps what earlier runs created.
  New: `order.deleted.v1`, and `services.importRemoval`.
- 0a940fa: `nymbal import --since last` (or `--since <date>`) brings over what changed in WooCommerce since your last import: new products, customers, orders and reviews are created, and imported products take their new names, copy, images and prices (stock is left alone). An imported order that changed is counted, not rewritten; the report gains a "Changes since" section.
  `@nymbalhq/importers` exports `resolveSince` and `ImportSinceError`.
- 73c9738: `nymbal preview --source woocommerce --url … --key … --secret …` imports your WooCommerce store into a throwaway store and serves it on your storefront, and writes `nymbal-preview-report.{json,md}` (counts, differences, drafts) and `nymbal-redirects.csv`; your own store is not touched. A store already scaffolded copies `src/lib/page-policy.ts` (Astro) or `lib/page-policy.mjs` (Next.js) so images load from the API's origin.

  `nymbal import`: of two products whose slugs clash, the first in WooCommerce keeps the slug.

- b8d68df: `nymbal preview --lighthouse` builds your storefront for production and compares Lighthouse scores (median of `--lighthouse-runs`, default 3) of your WooCommerce home, a product and a category with the same pages in the preview, in a `## Lighthouse` section of the report. Install `lighthouse@^12` in the project, or point `NYMBAL_LIGHTHOUSE_CLI` at one; Chrome is needed.

### Patch Changes

- d2277af: `nymbal import` names each product image it could not bring over, with why (an HTTP status, a timeout, an unsupported type or a refused address), under "Media" in the migration report, and still imports the product with its other images. The report groups errors and review items by phase with counts, and the summary says "AI enrichment: off" when no AI provider is set.
- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
- f2c9a19: Signed-in shoppers can review a product (`POST /api/reviews`, 10 an hour per IP): one review per product, pending moderation, verified when they bought it (event `review.submitted.v1`); a guest sees "Sign in to write a review". `GET /api/products/:id/reviews` no longer publishes customer or order ids, and `GET /api/capabilities` reports `reviews`, so a reviews provider without `submit` shows no form.
  Breaking for a reviews adapter or a kernel composed by hand: `ReviewSubmission` carries `author`, an adapter without `submit` rejects with `ReviewRefusedError`, and `buildServices` takes `reviews`. A scaffolded store copies `src/lib/reviews.ts` and `src/pages/product/[slug].astro` (Astro) or `lib/reviews.ts` and `app/(catalog)/product/[slug]/page.tsx` (Next.js).
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
- Updated dependencies [07ff236]
- Updated dependencies [7a136c9]
- Updated dependencies [7a136c9]
- Updated dependencies [040f754]
- Updated dependencies [a4a8db6]
- Updated dependencies [366760e]
- Updated dependencies [2be0e86]
- Updated dependencies [2fbb296]
- Updated dependencies [454e12a]
- Updated dependencies [c9fe50b]
- Updated dependencies [853d563]
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

## 0.3.4

### Patch Changes

- Updated dependencies [6c85536]
- Updated dependencies [f05e635]
- Updated dependencies [d2513b9]
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

## 0.3.3

### Patch Changes

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
  - @nymbalhq/platform@1.4.0
  - @nymbalhq/types@1.4.0
  - @nymbalhq/config@1.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/platform@1.3.0
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 0.3.1

- Versioned with the other packages; no changes of its own.

## 0.3.0

- Product images go to the store's media storage. **Breaking:** `WooCommerceImporterDeps` takes a required `media` (pass
  `app.platform.media`), and a failed image put is reported in `errors`.

## 0.2.1

- Skips AI enrichment when the store has no AI provider.

## 0.2.0

- First release under `@nymbalhq`.
- Paid WooCommerce orders import as captured.
- A fresh import state no longer shares ids, maps and errors with earlier imports in the same process.
