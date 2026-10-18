---
'@nymbalhq/sdk': minor
'@nymbalhq/react': minor
'@nymbalhq/web-components': patch
'nymbal': patch
'create-nymbal-app': minor
---

Honest storefront templates.
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
