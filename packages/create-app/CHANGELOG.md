# create-nymbal-app

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
