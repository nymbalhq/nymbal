---
'@nymbalhq/admin': patch
'@nymbalhq/ai-anthropic': patch
'@nymbalhq/ai-openai': patch
'@nymbalhq/document-store-postgres-jsonb': patch
'@nymbalhq/document-store-redis': patch
'@nymbalhq/email-mailgun': patch
'@nymbalhq/email-resend': patch
'@nymbalhq/email-ses': patch
'@nymbalhq/email-smtp': patch
'@nymbalhq/event-bus-redis-streams': patch
'@nymbalhq/media-s3': patch
'@nymbalhq/payments-stripe': patch
'@nymbalhq/search-algolia': patch
'@nymbalhq/security-cloudflare': patch
'@nymbalhq/shipping-easypost': patch
'nymbal': patch
'@nymbalhq/config': patch
'@nymbalhq/contract-tests': patch
'create-nymbal-app': patch
'@nymbalhq/http': patch
'@nymbalhq/importers': patch
'@nymbalhq/platform': patch
'@nymbalhq/react': patch
'@nymbalhq/sdk': patch
'@nymbalhq/stack': patch
'@nymbalhq/types': patch
'@nymbalhq/web-components': patch
---

Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
`create-nymbal-app` ends by naming where to report a problem.
