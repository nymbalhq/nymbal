---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
'nymbal': minor
---

Carts and orders record their `source`: `storefront`, `import`, or `agent:<name>` for one a shopping agent opened, kept through the buyer's sign-in. Migration `0022` adds the columns; existing rows read `storefront`.
The admin dashboard gains an Agents tile (the last 30 days' agent orders and revenue, per agent, and the surfaces on), and an order's page names its source.
`nymbal doctor` adds an `agents` line that warns when UCP checkout has no privacy or terms link in `agents.ucp.links`, or the public URL is plain http.
