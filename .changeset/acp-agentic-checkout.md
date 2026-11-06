---
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/types': minor
'@nymbalhq/http': minor
'@nymbalhq/payments-stripe': minor
---

Agentic checkout over ACP (beta, off by default): with `agents.acp.enabled` and `NYMBAL_ACP_API_KEY` set, a shopping agent opens a checkout session at `/api/acp` and pays with a delegated token (a Stripe Shared Payment Token) for a normal store order.
