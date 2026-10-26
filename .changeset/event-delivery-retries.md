---
'@nymbalhq/platform': minor
'nymbal': minor
---

Breaking in effect for your own handlers: a named handler that throws is now retried, up to five times over about 2.5 minutes, before its event is dead, so make it idempotent (for example with `withIdempotency`). `createApp` takes `relay` options for the attempts and the delay.
Migration `0015` adds `events.retry_at`. `nymbal doctor` lists dead events, and `nymbal events query --json` prints `attempts` and `deadAt`.
