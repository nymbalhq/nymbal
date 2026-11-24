# @nymbalhq/promotions-talon-one

The `talon-one` promotions provider for Nymbal. Talon.One decides every discount: a code typed in the cart, at
checkout or by an agent is accepted or refused by Talon.One, campaigns that need no code apply by themselves, and the
store settles the order's total from Talon.One's answer under the same totals rule as the built-in engine.

```sh
npm install @nymbalhq/promotions-talon-one
```

```ts
// nymbal.config.ts
commerce: {
  promotions: {
    provider: 'talon-one',
    config: {
      baseUrl: 'https://<deployment>.talon.one',
      apiKey: env('TALON_ONE_API_KEY'),
      currency: 'GBP',
    },
  },
}
```

- `baseUrl` is your Talon.One deployment. It must be `https:`, and it is read from the config only: the admin's
  Settings cannot change where the key is sent.
- `apiKey` is an Integration API key of the Application. It may be left out of the config and saved in the admin's
  Settings instead; until it is set, the store takes orders at full price and refuses codes.
- `currency` is the Application's currency, in which Talon.One reads every price. A cart in another currency is
  treated as Talon.One being down (below).
- `timeoutMs` (optional, 2500 ms) is how long a call to Talon.One may take.

## What is sent

Each cart change asks Talon.One with a dry evaluation, keyed by the cart, which saves nothing. Placing an order opens
one customer session at Talon.One under the order's id, with the cart's items (by SKU, or the variant id where the
variant has none), its codes and the customer's id for a signed-in shopper. When the order is paid the session is
closed, so the code's use is counted; when the order is cancelled it is cancelled, so the use is given back. Each is
sent once per order, however often the store retries.

## What is applied

Cart discounts (`setDiscount`) and per-item discounts (`setDiscountPerItem`) become the order's and the line's
discounts, accepted and refused codes show in the cart with their reason, and notifications show as notices. Shipping
discounts, free items, loyalty points and referrals are ignored; a code whose only effects are ones of those is shown
as refused rather than applied. A refund leaves the Talon.One session closed.

When Talon.One cannot be reached, answers with an error or takes longer than `timeoutMs`, the store shows no discount
it has not been given: adding a code answers 503 and a cart holding a code cannot check out until Talon.One answers.
