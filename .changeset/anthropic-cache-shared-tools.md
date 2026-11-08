---
'@nymbalhq/ai-anthropic': patch
'@nymbalhq/ai-openai': patch
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'nymbal': minor
---

Anthropic requests cache the tool definitions and system prompt for later conversations too, so a new assistant conversation reads them from the cache instead of paying to write them again.
Chat `usage` adds `cacheReadTokens` and `cacheWriteTokens` where the provider reports them (OpenAI: cached prompt tokens), and `nymbal eval assistant` prints token usage per run and in total, also in `--json`.
