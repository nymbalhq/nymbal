---
'@nymbalhq/platform': minor
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

Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.
