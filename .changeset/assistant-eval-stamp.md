---
'nymbal': minor
'@nymbalhq/platform': minor
---

`nymbal eval assistant --stamp <file>` records a passing run against Anthropic's or OpenAI's own API: the hash of the assistant's prompt and tools, the provider, the model and the tally. `--json` now includes that hash, and each run's report lists the models that answered.
