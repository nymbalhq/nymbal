---
'@nymbalhq/platform': patch
'@nymbalhq/types': patch
---

A repeat stock or price alert subscribe sends no second confirmation within 10 minutes of the last (new event `alert.confirmation_sent.v1`; migration `0020`). Alerts skip an address that unsubscribed mid-send, retention keeps dead events, and read models no longer keep a stale document when `nymbal replay` runs beside a live server.
