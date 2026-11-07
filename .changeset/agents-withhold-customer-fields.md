---
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
---

Admin MCP tool results no longer carry customers' emails, phones, street lines or postcodes; `agents.mcp.withhold` lists what is withheld and each result names it in `withheld`. Breaking for admin MCP clients that read those fields: set `agents.mcp.withhold: []` to send them.
