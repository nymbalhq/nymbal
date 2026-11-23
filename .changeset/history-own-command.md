---
'@nymbalhq/types': patch
'@nymbalhq/platform': patch
---

A record's history names each change's own actor and command, so a payment an admin or a provider records after checkout no longer reads as the shopper's checkout; entries recorded before this release are unchanged (new column `events.command_id`; run migrations).
