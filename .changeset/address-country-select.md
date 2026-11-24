---
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
'@nymbalhq/web-components': minor
---

Breaking: an address's country must be an ISO 3166-1 two-letter code (`UK`, `United Kingdom` and `GBR` are refused; use `GB`), and a US region a state's code or name; the config refuses a non-ISO country in `store.shipFrom`, tax and shipping rates.
The address form picks the country, and a US state, from a list.
