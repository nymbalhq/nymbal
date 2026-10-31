# @nymbalhq/email-ses

## 1.5.0

### Minor Changes

- ab6c631: New `ses` email provider (`@nymbalhq/email-ses`): it sends over Amazon SES SMTP, and its SNS bounce and complaint
  notifications stop alert mail to bad addresses. Subscribe the SNS topic to `/api/webhooks/ses` over HTTPS.

### Patch Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.
- Updated dependencies [6c85536]
- Updated dependencies [f05e635]
- Updated dependencies [d2513b9]
  - @nymbalhq/email-smtp@1.5.0
