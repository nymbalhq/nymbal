---
'@nymbalhq/types': minor
'@nymbalhq/platform': patch
'@nymbalhq/ai-openai': patch
'nymbal': patch
---

A provider package can declare a secret optional when another setting is set (`optionalWith` on a `settings` entry).
`@nymbalhq/ai-openai` works with Ollama, vLLM and other keyless OpenAI-compatible servers at a `baseUrl` without a dummy `apiKey`, and sends no `Authorization` header when it has no key.
A keyless host needs this release of `@nymbalhq/platform` too; with an older kernel the slot stays not configured.
