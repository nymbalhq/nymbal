---
title: Agents
description: MCP, the Universal Commerce Protocol, and proposals an admin approves.
---

A Nymbal store is ready for AI agents without a plugin. Shopping agents can browse and buy; admin agents can read and
change the catalogue and orders, with your approval.

## MCP

The store serves its tools at `POST /api/mcp` (Streamable HTTP). Which tools an agent sees depends on who it signs in
as: an anonymous agent gets the shopper's tools (products, search, reviews, cart, checkout), an admin's token adds the
admin's. Every tool is an API route, held to that route's rate limits.

An MCP host that launches stdio servers connects through `nymbal mcp`, which signs in and forwards every call to the
store:

```sh
NYMBAL_MCP_URL=http://localhost:8080/api/mcp npx nymbal mcp tools
```

| Variable                                  | What                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `NYMBAL_MCP_URL`                          | The store's endpoint (default: `http://localhost:<http.port>/api/mcp` from your config). |
| `NYMBAL_MCP_EMAIL`, `NYMBAL_MCP_PASSWORD` | Sign in as this user, and sign in again before the token lapses.                         |
| `NYMBAL_MCP_TOKEN`                        | Or a bearer the store signed.                                                            |

The [quickstart](../quickstart/#3-connect-an-agent) shows a host's config. A request from a browser origin outside
`http.cors.allowedOrigins` is refused.

## Proposals and the inbox

By default an agent's admin write does not run. It answers `status: proposed` and waits in the admin's **Inbox**
(`/admin/inbox`) until someone approves it, when it runs as that person, or rejects it. Every proposal is recorded with the agent's name and version, whatever is decided.

```ts
agents: {
  mcp: { enabled: true, writes: 'proposal' },
  autoApprove: [],
},
```

`writes: 'apply'` approves every command at the call. `autoApprove` lists commands that run at once under
`proposal`; a command that moves money (a refund, say) cannot be listed. Carts and orders an agent opened record it as
their source, and the admin's Agents tile counts them.

## UCP

The store publishes a Universal Commerce Protocol profile at `/.well-known/ucp`, and its UCP tools at
`POST /api/ucp/mcp`, so an agent that speaks UCP can check out. A UCP checkout names your legal pages:

```ts
agents: {
  ucp: { enabled: true, links: [
  { type: 'privacy_policy', url: 'https://example.com/privacy' },
  { type: 'terms_of_service', url: 'https://example.com/terms' },
] },
},
```

`nymbal doctor` warns when UCP checkout has no privacy or terms link, or the public URL is plain http.

## Crawlers

`agents.crawl` sets what `robots.txt`, `llms.txt` and the product feed (`/agents/products.json`) serve, and which AI
crawlers are allowed.
