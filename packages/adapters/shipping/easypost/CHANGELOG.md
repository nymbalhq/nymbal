# @nymbalhq/shipping-easypost

## 1.6.0

### Minor Changes

- 37d8f4a: Shipping adapters declare `rates`, `labels` and `tracking` and have only those methods (`rate`, `createLabel` and the new `startTracking` are optional; `track()` and `ShippingTracking` are removed; rate and label params and results are reshaped; native declares none), `GET /api/capabilities` reports `shipping`, and `runShippingContract` checks the words against the methods.
  A shipped order's tracking number is registered with a provider that declares `tracking`: `@nymbalhq/shipping-easypost` with an `apiKey` (which also rates and buys labels), or the new `@nymbalhq/shipping-aftership`.
  `store.shipFrom` sets the address the store ships from.

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.

## 1.5.0

### Minor Changes

- 59e1639: New `easypost` shipping provider (`@nymbalhq/shipping-easypost`): set `shipping.provider: 'easypost'`, and its tracker
  webhooks (`/api/webhooks/easypost`) mark a shipped order delivered.

### Patch Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.
