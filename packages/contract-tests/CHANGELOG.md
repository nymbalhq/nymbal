# @nymbalhq/contract-tests

## 1.4.0

### Minor Changes

- d724fd2: Breaking for event bus adapters: when a handler of a named subscription throws, `publish` now rejects with `adapter.handler_failed` (build it with `handlerFailedError`), once every matching handler has finished. Unnamed subscriptions are still only logged.
  The contract suite's throwing-handler delivery case now expects the rejection, and gains the handler-failure cases.
- 6f73872: Any commerce adapter can take webhooks at `POST /api/webhooks/<providerName>` by implementing the optional `receiveWebhook(rawBody, headers)`; a delivery sent twice, even at once, is processed once. Its events must be named `<providerName>.<event>.v<n>` and listed in `producesEvents`, each payload a plain JSON object. `/api/webhooks/stripe` is unchanged.
  `runWebhookContract` certifies an adapter's `receiveWebhook`, and `webhookDeliveryProblem` from `@nymbalhq/types` gives the rule both apply, the first reason a delivery is refused or null.
- d546cd3: Breaking: `createNativeAiAdapter` is removed; it threw on every call. Set `ai: { provider: 'none' }` or `'anthropic'` in its place.
  `runAiContract` and the `ai` kind of `nymbal test:contracts` are removed; test a custom AI adapter with your own suite.

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- First release: the suites every adapter passes (`run<Kind>Contract`, `contractSuites`), for certifying your own with
  `nymbal test:contracts --package`.
- The document store suite checks `replaceCollection`, so a third-party store must implement it.
