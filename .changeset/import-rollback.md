---
'nymbal': minor
'@nymbalhq/importers': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
---

`nymbal import --rollback` removes every record your imports created (customers that already had an account stay) and refuses once the store has orders or reviews of its own; `--yes` skips the question. Media files are kept.
The import's state file is saved atomically with a journal beside it, so a stopped import or rollback loses nothing, and an unreadable state file stops `nymbal import` instead of starting again. `--fresh` keeps what earlier runs created.
New: `order.deleted.v1`, and `services.importRemoval`.
