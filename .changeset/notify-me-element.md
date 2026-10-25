---
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/sdk': minor
---

`<nymbal-notify-me>` (`NotifyMe` in `@nymbalhq/react`) shows the selected variant's back-in-stock form while it is out of stock; the SDK adds `client.adapter.alerts.subscribe()`.
Breaking for a custom `CommerceAdapter`: add `alerts.subscribe({ email, variantId, kind })`.
