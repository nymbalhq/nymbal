---
'@nymbalhq/platform': minor
'nymbal': minor
---

`nymbal replay --to reports` rebuilds report figures from the event log for the days it still holds whole (`--dry-run` counts what would change); run it after upgrading or to repair reports, with the server stopped or idle on SQLite.
