# @nymbalhq/doc-store-redis

## 1.2.0

- On a dead server a command rejects within seconds, and the client keeps reconnecting.
- Implements `replaceCollection` by staging a hash and renaming it, for `nymbal replay`.

## 1.1.0

- First release: the `redis` document store, configured by `infrastructure.redis` (`url`, `prefix`).
- `healthCheck()` answers with `PING`.
- Ships the `redis` recipe for `nymbal add redis`.
