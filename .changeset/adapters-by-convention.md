---
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'nymbal': minor
'@nymbalhq/payments-stripe': patch
'@nymbalhq/email-smtp': patch
'@nymbalhq/email-mailgun': patch
'@nymbalhq/email-resend': patch
'@nymbalhq/email-ses': patch
'@nymbalhq/ai-anthropic': patch
'@nymbalhq/shipping-easypost': patch
'@nymbalhq/document-store-redis': patch
'@nymbalhq/document-store-postgres-jsonb': patch
'@nymbalhq/event-bus-redis-streams': patch
'@nymbalhq/media-s3': patch
'@nymbalhq/security-cloudflare': patch
---

Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
`media`.
Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
`PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
`config.security_adapter_unknown` is now `adapter.provider_unknown`.
