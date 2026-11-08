---
'@nymbalhq/ai-anthropic': minor
'@nymbalhq/ai-openai': minor
'@nymbalhq/contract-tests': minor
---

Breaking: a spent credit balance or quota is now `adapter.quota_exceeded` and an overloaded provider (529) `adapter.overloaded`; code that branched on `adapter.invalid_request`, `adapter.rate_limited` or `adapter.unavailable` for these must check the new codes, and an AI adapter certified with @nymbalhq/contract-tests must reject a 529 with `adapter.overloaded`.
AI errors also carry the provider's own message (up to 200 characters, keys and the conversation removed), so "anthropic answered 400" reads why.
