---
'@nymbalhq/platform': minor
'@nymbalhq/http': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'nymbal': minor
---

A store answers shopping agents out of the box: a UCP 2026-08-25 profile at `/.well-known/ucp`, its catalogue search and checkout tools at `POST /api/ucp/mcp`, and a `continue_url` that hands the agent's cart to your checkout page.
The API also serves `/robots.txt` (named AI crawlers allowed, shopper and admin paths kept out), `/llms.txt` and `/agents/products.json`.
Set `agents.ucp.links` to your privacy and terms pages; `agents.ucp.enabled` and `agents.crawl` (`robots`, `llms`, `feed`, `allow`, `others`) turn each part off or change it.
