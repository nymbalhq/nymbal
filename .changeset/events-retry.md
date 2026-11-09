---
'@nymbalhq/platform': minor
'nymbal': minor
---

`nymbal events retry` lists dead events and puts them back for the running store to deliver, 100 a run; events older than `events.retentionDays` stay dead, and `nymbal doctor` names the command. Back-in-stock and price-drop alerts now re-read the variant, so a late event no longer mails a stale claim.
