# @nymbalhq/shipping-easypost

The `easypost` shipping provider for Nymbal. It takes EasyPost's tracker webhooks, so when the carrier reports a
parcel delivered, the shipped order with that tracking number moves to `delivered`, on its timeline and in the admin.
With an API key it also registers each shipped order's tracking number with EasyPost, and rates parcels and buys
labels.

```sh
npm install @nymbalhq/shipping-easypost
```

```ts
// nymbal.config.ts
commerce: {
  shipping: {
    provider: 'easypost',
    config: {
      apiKey: env('EASYPOST_API_KEY'),
      webhookSecret: env('EASYPOST_WEBHOOK_SECRET'),
    },
  },
}
```

- `webhookSecret` is the secret you set on the webhook in EasyPost's dashboard. It may be left out of the config and
  saved in the admin's Settings instead. Without it the store refuses every webhook post and the shipping slot's
  health is `degraded`.
- `apiKey` is your EasyPost API key (a Test key for test mode). It may also be saved in the admin's Settings. With it
  the adapter declares `rates`, `labels` and `tracking`; without it, none of them, and it only takes webhooks.
- `apiBase` points the adapter at another address for EasyPost's API (a proxy); it defaults to
  `https://api.easypost.com/v2/`.

## Tracking registration

When you ship an order (the admin's Mark Shipped), the store sends its tracking number to EasyPost as a tracker, so a
number you typed by hand is tracked and its updates come back by webhook. The carrier is named to EasyPost when it
reads as USPS, UPS, FedEx, DHL (DHL Express) or Royal Mail, case and spaces ignored; any other is left for EasyPost to
detect. A number EasyPost refuses is logged with the order id and not retried; while EasyPost cannot be reached the
store tries again later, and the order stays `shipped` either way.

## Rates and labels

`rate({ from, to, parcel })` asks EasyPost for a shipment's rates. The parcel's grams and millimetres are sent as
ounces and inches, each rounded up to 0.1. Each rate's `id` is what `createLabel({ rateId })` buys; buying one rate
again answers the label already bought rather than buying a second. Amounts are read exactly in the currency's minor
units; an amount finer than the currency is refused, never rounded. Nymbal's checkout does not call these yet.

A refusal from EasyPost (a 4xx) rejects with `adapter.shipping.refused` and EasyPost's message; a 429, a 5xx, no
answer within 10 s or no connection rejects with `adapter.shipping.unavailable`, and the slot's health is `down`
until EasyPost answers. A key EasyPost refuses makes health `degraded`.

## Webhooks

In EasyPost, add a webhook for `<api origin>/api/webhooks/easypost` with the same webhook secret. It sends tracker
events, `tracker.created` and `tracker.updated`, which is what the store reads. The order is found by the tracking
number it was shipped with, so ship each order with the tracking code EasyPost tracks.

| EasyPost status | Recorded as |
|---|---|
| `pre_transit` | `pre_transit` |
| `in_transit` | `in_transit` |
| `out_for_delivery`, `available_for_pickup` | `out_for_delivery` |
| `delivered` | `delivered` |
| `return_to_sender` | `returned` |
| `failure`, `error`, `cancelled` | `exception` |
| `unknown`, any other | `unknown` |

Only `delivered` changes the order, and only a shipped one. Any other EasyPost event posted to the same URL is
answered 200 and ignored.

Only a post whose `X-Hmac-Signature` matches its exact body under the secret is accepted. EasyPost retries a post
that did not get a 2xx under the same event id, and the store handles each event id once: a retry that arrives while
the first post is still being handled is answered `deduped`.
