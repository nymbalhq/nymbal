---
'@nymbalhq/ai-anthropic': minor
---

Requests use Anthropic's prompt caching, so the assistant's system prompt, tools and earlier turns, resent on every step of a conversation, are billed as cache reads instead of full input. `usage.inputTokens` still counts every input token, cached or not.
