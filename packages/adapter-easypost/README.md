# @nymbalhq/adapter-easypost

The `easypost` shipping provider for Nymbal. It takes EasyPost's tracker webhooks, so when the carrier reports a
parcel delivered, the shipped order with that tracking number moves to `delivered`, on its timeline and in the admin.

```sh
npm install @nymbalhq/adapter-easypost
```

```ts
// nymbal.config.ts
commerce: {
  shipping: {
    provider: 'easypost',
    config: {
      webhookSecret: env('EASYPOST_WEBHOOK_SECRET'),
    },
  },
}
```

- `webhookSecret` is the secret you set on the webhook in EasyPost's dashboard. It may be left out of the config and
  saved in the admin's Settings instead. Without it the store refuses every webhook post and the shipping slot's
  health is `degraded`.
- Rates, labels and tracking lookups through EasyPost's API are not supported: `rate`, `createLabel` and `track`
  reject with `adapter.shipping.unsupported`. Nymbal's checkout does not call them.

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
