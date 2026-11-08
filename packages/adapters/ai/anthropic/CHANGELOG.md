# @nymbalhq/ai-anthropic

## 1.8.0

### Minor Changes

- c347277: Breaking: a spent credit balance or quota is now `adapter.quota_exceeded` and an overloaded provider (529) `adapter.overloaded`; code that branched on `adapter.invalid_request`, `adapter.rate_limited` or `adapter.unavailable` for these must check the new codes, and an AI adapter certified with @nymbalhq/contract-tests must reject a 529 with `adapter.overloaded`.
  AI errors also carry the provider's own message (up to 200 characters, keys and the conversation removed), so "anthropic answered 400" reads why.
- 5811a80: Requests use Anthropic's prompt caching, so the assistant's system prompt, tools and earlier turns, resent on every step of a conversation, are billed as cache reads instead of full input. `usage.inputTokens` still counts every input token, cached or not.

### Patch Changes

- 5b51750: Anthropic requests cache the tool definitions and system prompt for later conversations too, so a new assistant conversation reads them from the cache instead of paying to write them again.
  Chat `usage` adds `cacheReadTokens` and `cacheWriteTokens` where the provider reports them (OpenAI: cached prompt tokens), and `nymbal eval assistant` prints token usage per run and in total, also in `--json`.

## 1.7.0

### Minor Changes

- 071e340: The admin's assistant sends a customer's email, phone, street lines and postcode to the AI provider as placeholders (`[email-1]`) and shows you the real values; choose the fields in `agents.assistant.mask` (`[]` turns it off). `nymbal doctor` names the AI host and what it receives.

## 1.6.0

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

## 1.5.0

### Minor Changes

- 6c85536: Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
  (from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
  (from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
  Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.

### Patch Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.

## 1.4.0

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- Declares `apiKey` (`ANTHROPIC_API_KEY`) and `baseUrl` as settings the admin can fill, and passes `baseUrl` to the SDK.

## 1.1.0

- Versioned with the other packages; no changes of its own.

## 1.0.0

- First release: the Anthropic AI adapter, moved out of the kernel. Install it with `@anthropic-ai/sdk` when the config
  names `ai: { provider: 'anthropic' }`.
