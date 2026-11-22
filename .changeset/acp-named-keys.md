---
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
'nymbal': patch
---

Breaking: `agents.acp.apiKey` and `NYMBAL_ACP_API_KEY` are removed; list each assistant's key by name in `agents.acp.keys`, such as `[{ name: 'muse', key: env('NYMBAL_ACP_API_KEY_MUSE') }]`.
An ACP order's source is `agent:<name>` of the key that opened it and each activity entry's actor `acp:<name>` of the key that sent it; `nymbal doctor` lists the keys by name.
