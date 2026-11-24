---
'@nymbalhq/promotions-talon-one': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

New `@nymbalhq/promotions-talon-one`: `commerce.promotions: { provider: 'talon-one', config: { baseUrl, apiKey, currency } }` lets Talon.One decide every code and code-less campaign, priced under the store's totals rule.
A paid order closes its promotions engine session and a cancelled order cancels it, once, for an engine that supports it, so Talon.One counts a code's use and gives it back.
