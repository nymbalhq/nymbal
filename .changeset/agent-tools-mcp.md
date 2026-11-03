---
'@nymbalhq/platform': minor
'@nymbalhq/http': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'nymbal': minor
---

The API's routes are MCP tools for agents, at `POST /api/mcp` (bearer, no cookie) and through `nymbal mcp`, a stdio bridge an MCP host launches (`NYMBAL_MCP_URL`, `NYMBAL_MCP_TOKEN` or `NYMBAL_MCP_EMAIL`/`NYMBAL_MCP_PASSWORD`).
A tool that runs a command only proposes it until you set `agents: { mcp: { writes: 'apply' } }`; `agents.mcp.enabled: false` turns the endpoint off.
`@nymbalhq/http` now depends on the MCP TypeScript SDK, which brings Zod 4.
