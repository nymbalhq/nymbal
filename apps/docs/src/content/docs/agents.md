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

### Customer details agents are not sent

An admin agent's tool results carry no customer email, phone, street line or postcode, over `POST /api/mcp` and
`nymbal mcp` alike. `agents.mcp.withhold` lists the fields withheld: any of `email`, `phone`, `address` (street lines),
`postcode` and `name` (first and last names). The default is `['email', 'phone', 'address', 'postcode']`, the fields
the admin's assistant masks by default: names are sent.

A result that lost a value names its kind in `withheld` (`withheld: ['email', 'address']`), so an agent can tell a
withheld email from a missing one. Emails and phones typed into text, such as an order note or a proposal's reason, are
replaced with `[email withheld]` and `[phone withheld]`. A street line or postcode typed into a note is replaced only
where it repeats a value the same result withheld; other addresses typed into notes are not detected.

```ts
agents: {
  mcp: { withhold: [] },
},
```

`withhold: []` sends every field as the admin API answers it.

Only admin tools are withheld: a shopper's agent still reads its own orders and account in full, and UCP and ACP
checkouts are unchanged. The admin's assistant is not affected by `agents.mcp.withhold`: it still reads each value and
masks it for its provider, as [The assistant and customer data](../assistant-data/) explains. `nymbal doctor` names
both on its `agents` line.

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

The admin's own assistant (**Ask**) proposes its writes the same way. A write it asks for after reading any tool
result, or in a follow-up message, always waits in the Inbox, whatever `autoApprove` lists, so text a shopper wrote (a
review, an order note) cannot make it change the store. [The assistant and customer data](../assistant-data/) says
what it sends to your AI provider.

In one message Ask makes at most three deletions, archives, cancellations or refunds, does not carry out such a change
to many records at once, and is not offered the store's settings.

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

## ACP (beta)

With `agents.acp` on, a shopping agent holding the store's key buys over the Agentic Commerce Protocol (2026-04-17) at
`/api/acp`: it reads the product feed (`GET /api/acp/feed`), opens and updates a checkout session, and completes it
with a delegated payment token (a Stripe Shared Payment Token), which the store charges through its payments provider.
The order is the one the storefront's checkout makes, with its source `agent:<name>`. It is off by default:

```ts
agents: {
  acp: { enabled: true, links: [{ type: 'terms_of_use', url: 'https://example.com/terms' }] },
},
```

The key is `NYMBAL_ACP_API_KEY` (or `agents.acp.apiKey`), at least 32 characters (`openssl rand -base64 32`); the
store refuses to start without it, or on a payments provider that cannot charge a delegated token (Stripe can).

## Crawlers

`agents.crawl` sets what `robots.txt`, `llms.txt` and the product feed (`/agents/products.json`) serve, and which AI
crawlers are allowed.
