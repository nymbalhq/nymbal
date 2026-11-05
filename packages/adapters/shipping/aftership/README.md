# @nymbalhq/shipping-aftership

The `aftership` shipping provider for Nymbal. When you ship an order it registers the tracking number with AfterShip,
and it takes AfterShip's tracking webhooks, so when the carrier reports a parcel delivered, the shipped order with that
tracking number moves to `delivered`, on its timeline and in the admin. It does not rate parcels or buy labels.

```sh
npm install @nymbalhq/shipping-aftership
```

```ts
// nymbal.config.ts
commerce: {
  shipping: {
    provider: 'aftership',
    config: {
      apiKey: env('AFTERSHIP_API_KEY'),
      webhookSecret: env('AFTERSHIP_WEBHOOK_SECRET'),
    },
  },
}
```

- `apiKey` is an AfterShip Tracking API key. With it the adapter declares `tracking`; without it, nothing, and it only
  takes webhooks.
- `webhookSecret` is the webhook secret in AfterShip's Settings > Webhooks. Without it the store refuses every webhook
  post and the shipping slot's health is `degraded`.
- Either may be left out of the config and saved in the admin's Settings instead. `apiBase` points the adapter at
  another address for AfterShip's API (a proxy); it defaults to `https://api.aftership.com`.

## Tracking registration

When you ship an order (the admin's Mark Shipped), the store creates the tracking in AfterShip (API version
`2026-07`), so a number you typed by hand is tracked. The courier slug is sent when the carrier reads as USPS, UPS,
FedEx, DHL (DHL Express), Royal Mail or `testing-courier`, case and spaces ignored; any other is left for AfterShip to
detect. A number AfterShip already holds counts as registered. One it refuses (an invalid number, an unknown courier,
a refused key) is logged with the order id and not retried; while AfterShip cannot be reached the store tries again
later, and the slot's health is `down` until AfterShip answers. The order stays `shipped` either way.

## Webhooks

In AfterShip, add a webhook for `<api origin>/api/webhooks/aftership`. It sends `tracking_update` events, which is
what the store reads; `edd_revise`, `tracking_pending_time` and any other event are answered 200 and ignored. The
order is found by the tracking number it was shipped with.

| AfterShip tag | Recorded as |
|---|---|
| `Pending`, `InfoReceived` | `pre_transit` |
| `InTransit` | `in_transit` |
| `OutForDelivery`, `AvailableForPickup` | `out_for_delivery` |
| `Delivered` | `delivered` |
| `AttemptFail`, `Exception` | `exception` |
| `Expired`, any other | `unknown` |

Only `delivered` changes the order, and only a shipped one.

Only a post whose `aftership-hmac-sha256` header is the base64 HMAC-SHA256 of its exact body under the webhook secret
is accepted. AfterShip retries a post that did not get a 2xx under the same `event_id`, and the store handles each
event id once.
