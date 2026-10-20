---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/adapter-stripe': minor
'@nymbalhq/config': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'nymbal': minor
'create-nymbal-app': minor
---

The storefronts render from what the store's adapters can do, never from which vendor is configured.

- `GET /api/capabilities` (public) answers the store's report: `payments` (`capabilities`, `client`), `search`
  (`capabilities`) and `catalog` (`sortKeys`, `defaultSort`). It names no provider and serves no secret.
  `StoreCapabilities`, `PaymentClient` and `PRODUCT_SORT_LABELS` are new in `@nymbalhq/types`. The SDK reads the
  report once per client with `client.capabilities.get()`.
- A payments adapter may describe its storefront half with `client(): { driver, options } | null`, where `options`
  holds public values only. The native stub answers `{ driver: 'test-mode', options: {} }`. Stripe answers
  `{ driver: 'stripe', options: { publishableKey } }`, from the new `publishableKey` in its config or
  `STRIPE_PUBLISHABLE_KEY`; a key that starts `sk_` or `rk_` there fails at start.
- `<nymbal-payment-element client='<json>'>` (React: `PaymentElement`) renders that client half through a driver
  from the SDK's registry (`registerPaymentDriver(name, driver)`, `getPaymentDriver(name)`), and its
  `confirm(clientSecret)` answers `{ ok: true, confirmed }` or `{ ok: false, error }`. `registerComponents()`
  registers the `test-mode` driver and a `stripe` driver that loads Stripe.js from js.stripe.com, so no project
  installs a Stripe package. A project registers a driver of its own in its client bootstrap; one registered under a
  built-in's name wins. A `null` client renders nothing; an unknown driver shows `payment-element-error`, and the
  checkout keeps Place Order disabled.
- `<nymbal-sort-dropdown sort-keys value default-sort>` (React: `SortDropdown`) offers the store's sort keys in its
  order and emits `nymbal:sort:changed` with `{ sort }`.
- `GET /api/products` leaves out `facets` when the search adapter does not report `facet`. Both templates render the
  product filter only from the listing's facets, the header search bar only when search reports `search`, and the sort
  options from `catalog.sortKeys`.
- `loadConfig()` returns the config module's named `adapters` export as `adapters`, and `nymbal dev` passes it to
  `createApp`, so a `custom` slot runs under `nymbal dev`.

**Breaking for a Stripe store and for a scaffolded checkout.** The templates no longer import `@stripe/*`, read
`PUBLIC_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` or `*_NYMBAL_PAYMENTS_PROVIDER`, and
`nymbal dev` no longer sets the latter. Give the API the publishable key instead (`payments.config.publishableKey`
or `STRIPE_PUBLISHABLE_KEY`). The payment step's test id is `payment-element` (was `stripe-card-element` on Astro and
`card-element` on Next), and Next's `CheckoutForm` takes the report as its `capabilities` prop. Card confirmation no
longer sends billing details to Stripe.
