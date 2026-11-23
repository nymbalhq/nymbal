---
'nymbal': patch
---

`nymbal replay` refuses a store with migrations pending and says to run `nymbal migrate`, instead of failing on a missing column.
`nymbal dev` and `nymbal start` print a config error's code after its message, as `<message> [<code>]`; `nymbal import --dry-run` refuses a currency mismatch.
