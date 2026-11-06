---
'@nymbalhq/types': minor
'@nymbalhq/contract-tests': minor
'@nymbalhq/ai-anthropic': minor
'@nymbalhq/ai-openai': minor
---

`AiAdapter.chat(messages, { system, maxTokens })` on Anthropic and the new `@nymbalhq/ai-openai` (`config: { model, baseUrl? }`, any OpenAI-compatible server).
A custom ai adapter must now add `chat()`; `nymbal test:contracts --package` certifies it.
Each call makes one attempt within `timeoutMs` (60 s by default) and throws an `AdapterError` that never carries the key.
