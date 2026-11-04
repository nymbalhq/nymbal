---
'@nymbalhq/types': minor
'@nymbalhq/contract-tests': minor
'@nymbalhq/ai-anthropic': minor
'@nymbalhq/ai-openai': minor
---

`chat()` takes `tools` and a `signal` and answers `toolCalls`, and `chatStream()` streams the answer, on Anthropic and OpenAI. A custom ai adapter's `chat()` must now return `toolCalls` (`[]` when none).
`@nymbalhq/ai-openai` sends `max_completion_tokens` to api.openai.com and `max_tokens` to any other host; `tokenField` in its config overrides it.
Anthropic requests no longer go through `@anthropic-ai/sdk`, so `DEBUG=true` prints neither the key nor the conversation.
