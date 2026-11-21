---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/admin': patch
'nymbal': patch
---

Shoppers can reset a forgotten password by email (`/account/forgot-password`) and change it on `/account/profile`, which signs out every other session; one account's failed sign-ins are refused past ten times the login limit until a reset.
Breaking: `security.auth.accessTtl` must be 1m to 1h and `refreshTtl` longer than it, or the store refuses to start, naming the field.
Per-address rate limits now count an IPv6 client by its /64, where before each full address was its own bucket.
