# @nymbalhq/ai-openai

## 0.3.0

### Minor Changes

- c347277: Breaking: a spent credit balance or quota is now `adapter.quota_exceeded` and an overloaded provider (529) `adapter.overloaded`; code that branched on `adapter.invalid_request`, `adapter.rate_limited` or `adapter.unavailable` for these must check the new codes, and an AI adapter certified with @nymbalhq/contract-tests must reject a 529 with `adapter.overloaded`.
  AI errors also carry the provider's own message (up to 200 characters, keys and the conversation removed), so "anthropic answered 400" reads why.

### Patch Changes

- 5b51750: Anthropic requests cache the tool definitions and system prompt for later conversations too, so a new assistant conversation reads them from the cache instead of paying to write them again.
  Chat `usage` adds `cacheReadTokens` and `cacheWriteTokens` where the provider reports them (OpenAI: cached prompt tokens), and `nymbal eval assistant` prints token usage per run and in total, also in `--json`.

## 0.2.0

### Minor Changes

- 071e340: The admin's assistant sends a customer's email, phone, street lines and postcode to the AI provider as placeholders (`[email-1]`) and shows you the real values; choose the fields in `agents.assistant.mask` (`[]` turns it off). `nymbal doctor` names the AI host and what it receives.

## 0.1.0

### Minor Changes

- d441055: `AiAdapter.chat(messages, { system, maxTokens })` on Anthropic and the new `@nymbalhq/ai-openai` (`config: { model, baseUrl? }`, any OpenAI-compatible server).
  A custom ai adapter must now add `chat()`; `nymbal test:contracts --package` certifies it.
  Each call makes one attempt within `timeoutMs` (60 s by default) and throws an `AdapterError` that never carries the key.
- 061bc68: `chat()` takes `tools` and a `signal` and answers `toolCalls`, and `chatStream()` streams the answer, on Anthropic and OpenAI. A custom ai adapter's `chat()` must now return `toolCalls` (`[]` when none).
  `@nymbalhq/ai-openai` sends `max_completion_tokens` to api.openai.com and `max_tokens` to any other host; `tokenField` in its config overrides it.
  Anthropic requests no longer go through `@anthropic-ai/sdk`, so `DEBUG=true` prints neither the key nor the conversation.

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.
