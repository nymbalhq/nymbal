---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/web-components': minor
'create-nymbal-app': minor
---

Price-drop alerts: `POST /api/alerts/subscribe` accepts `kind: 'price_drop'`, and a confirmed subscriber is emailed each time the variant's price falls below the last price they were told. `<nymbal-notify-me>` shows the price-drop form for an in-stock variant, and both templates' `/alerts/confirm` page names the alert's kind.
