# @nymbalhq/importers

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
